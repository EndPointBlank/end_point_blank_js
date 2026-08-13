'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { AccessTokens } = require('../../src/tokens/access-tokens');

/**
 * Only the network is faked; `GenerateAccessToken` runs for real underneath,
 * so these also cover the request the SDK actually makes for a token.
 *
 * A token is cached under the canonical base URL intake resolved the request
 * to -- not under the URL the caller supplied. A caller asks for the URL it
 * is about to call; intake answers with the base URL of the environment that
 * URL belongs to, and subsequent calls anywhere under that base URL reuse the
 * entry. A process that calls several targets therefore holds several
 * tokens.
 */

const BASE = 'https://api.example.com/orders';

const secondsFromNow = seconds => new Date(Date.now() + seconds * 1000).toISOString();

const tokenPayload = (token = 'tok-1', { expiresInSeconds = 3600, baseUrl = BASE, ...overrides } = {}) => ({
  token,
  expired_at: secondsFromNow(expiresInSeconds),
  base_url: baseUrl,
  ...overrides,
});

const tokenResponse = body => ({
  status: 201,
  ok: true,
  json: async () => body,
});

describe('AccessTokens', () => {
  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    AccessTokens.clear();
    post.mockReset();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    AccessTokens.clear();
    config._reset();
  });

  describe('keying on the base URL', () => {
    // A token is cached under the canonical base URL intake resolved the
    // request to, not under the URL the caller supplied. Lookup is an
    // exact-or-path-prefix comparison with the longest match winning.

    test('caches under the base URL intake returned', async () => {
      post.mockResolvedValue(
        tokenResponse(tokenPayload('tok-1', { baseUrl: 'https://example.com/orders' })),
      );

      await expect(AccessTokens.token('https://example.com/orders/widgets/42')).resolves.toBe('tok-1');
      // A different path under the same registered base URL reuses the entry.
      await expect(AccessTokens.token('https://example.com/orders/anything')).resolves.toBe('tok-1');

      // The caller's URL went out verbatim; the response's base_url became the key.
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][2]).toEqual({ base_url: 'https://example.com/orders/widgets/42' });
    });

    test('keeps distinct base URLs apart', async () => {
      // The reason the cache is a map at all: a service that calls two
      // targets needs a token for each, and holding one would send the wrong
      // credential to the second.
      const issued = {
        'https://a.example.com': tokenPayload('tok-a', { baseUrl: 'https://a.example.com' }),
        'https://b.example.com': tokenPayload('tok-b', { baseUrl: 'https://b.example.com' }),
      };
      post.mockImplementation(async (_url, _auth, body) => tokenResponse(issued[body.base_url]));

      await expect(AccessTokens.token('https://a.example.com')).resolves.toBe('tok-a');
      await expect(AccessTokens.token('https://b.example.com')).resolves.toBe('tok-b');
      await expect(AccessTokens.token('https://a.example.com')).resolves.toBe('tok-a');

      expect(post).toHaveBeenCalledTimes(2);
    });

    test('the longest matching prefix wins', async () => {
      // Seeded narrow-first: once the broad entry exists nothing under it can
      // miss, so this is the only order in which both entries can be
      // created.
      post
        .mockResolvedValueOnce(tokenResponse(tokenPayload('narrow', { baseUrl: 'https://example.com/orders' })))
        .mockResolvedValueOnce(tokenResponse(tokenPayload('broad', { baseUrl: 'https://example.com' })));

      await AccessTokens.token('https://example.com/orders/42');
      await AccessTokens.token('https://example.com/other');

      await expect(AccessTokens.token('https://example.com/orders/42')).resolves.toBe('narrow');
      await expect(AccessTokens.token('https://example.com/other')).resolves.toBe('broad');
      expect(post).toHaveBeenCalledTimes(2);
    });

    test('a prefix match respects segment boundaries', async () => {
      // "/ordersXX" must NOT match "/orders" -- a prefix that stops
      // mid-segment is a different resource, and reusing the token would
      // present it to a base URL it was never issued for.
      post
        .mockResolvedValueOnce(tokenResponse(tokenPayload('tok-orders', { baseUrl: 'https://example.com/orders' })))
        .mockResolvedValueOnce(tokenResponse(tokenPayload('tok-other', { baseUrl: 'https://example.com/ordersXX' })));

      await AccessTokens.token('https://example.com/orders');

      await expect(AccessTokens.token('https://example.com/ordersXX')).resolves.toBe('tok-other');
      expect(post.mock.calls[1][2]).toEqual({ base_url: 'https://example.com/ordersXX' });
    });

    test.each([
      ['a different case', 'https://example.com/Orders'],
      ['a query string', 'https://example.com/orders?page=2'],
    ])('a non-canonical URL misses rather than guessing: %s', async (_label, requested) => {
      // The SDK does not normalize -- intake owns that rule. A URL that does
      // not match character-for-character costs one extra request, which is
      // cheaper than presenting a token issued for somewhere else. (A query
      // string should have been stripped before it got here; missing is the
      // right answer when it was not.)
      post
        .mockResolvedValueOnce(tokenResponse(tokenPayload('tok-1', { baseUrl: 'https://example.com/orders' })))
        .mockResolvedValueOnce(tokenResponse(tokenPayload('tok-2', { baseUrl: 'https://example.com/orders' })));

      await AccessTokens.token('https://example.com/orders');

      await expect(AccessTokens.token(requested)).resolves.toBe('tok-2');
      expect(post).toHaveBeenCalledTimes(2);
    });

    test('a trailing slash still matches', async () => {
      // Falls out of the "key + /" rule rather than from any normalization:
      // ".../orders/" starts with ".../orders/". Worth pinning, because it is
      // the one non-identical form that does NOT cost an extra mint.
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1', { baseUrl: 'https://example.com/orders' })));

      await AccessTokens.token('https://example.com/orders');

      await expect(AccessTokens.token('https://example.com/orders/')).resolves.toBe('tok-1');
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetching', () => {
    test('returns the token the service issued', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));

      await expect(AccessTokens.token(BASE)).resolves.toBe('tok-1');
    });

    test('sends the base URL, not a hostname, verbatim in the request body', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));

      await AccessTokens.token(BASE);

      expect(post.mock.calls[0][2]).toEqual({ base_url: BASE });
    });

    test('reuses a live token instead of asking again', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));

      await AccessTokens.token(BASE);
      await AccessTokens.token(BASE);

      expect(post).toHaveBeenCalledTimes(1);
    });

    test('renews a token that is about to expire rather than presenting it', async () => {
      // A token with a minute left will very likely be dead by the time the
      // call lands, so it is refreshed inside a two-minute buffer.
      post
        .mockResolvedValueOnce(tokenResponse(tokenPayload('nearly-dead', { expiresInSeconds: 60 })))
        .mockResolvedValueOnce(tokenResponse(tokenPayload('fresh')));

      await AccessTokens.token(BASE);

      await expect(AccessTokens.token(BASE)).resolves.toBe('fresh');
    });

    test('does not retain a token that arrives already expired', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1', { expiresInSeconds: -1 })));

      await AccessTokens.token(BASE);

      expect(AccessTokens.exists(BASE)).toBe(false);
    });
  });

  describe('concurrent callers', () => {
    test('a burst of requests for the same base URL triggers a single fetch', async () => {
      let release;
      const pending = new Promise(resolve => {
        release = resolve;
      });
      post.mockImplementation(() => pending);

      const callers = Promise.all(Array.from({ length: 10 }, () => AccessTokens.token(BASE)));

      release(tokenResponse(tokenPayload('tok-1')));

      await expect(callers).resolves.toEqual(Array(10).fill('tok-1'));
      expect(post).toHaveBeenCalledTimes(1);
    });

    test('concurrent requests for different base URLs do not block each other', async () => {
      // Two distinct base URLs requested concurrently must produce two
      // in-flight requests, not one queued behind the other: if they shared
      // a single in-flight slot, the second call would resolve to the
      // first's token (or hang until the first settles) instead of getting
      // its own.
      let resolveA;
      let resolveB;
      const pendingA = new Promise(resolve => {
        resolveA = resolve;
      });
      const pendingB = new Promise(resolve => {
        resolveB = resolve;
      });

      post.mockImplementation(async (_url, _auth, body) =>
        body.base_url === 'https://a.example.com' ? pendingA : pendingB,
      );

      const callerA = AccessTokens.token('https://a.example.com');
      const callerB = AccessTokens.token('https://b.example.com');

      // B settles first, without waiting on A -- proof the two requests are
      // not serialized behind a single in-flight slot.
      resolveB(tokenResponse(tokenPayload('tok-b', { baseUrl: 'https://b.example.com' })));
      await expect(callerB).resolves.toBe('tok-b');

      resolveA(tokenResponse(tokenPayload('tok-a', { baseUrl: 'https://a.example.com' })));
      await expect(callerA).resolves.toBe('tok-a');

      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe('when a token cannot be obtained', () => {
    test('returns null when the service is unreachable', async () => {
      post.mockResolvedValue(null);

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();
    });

    test('returns null when the service answers without a token', async () => {
      post.mockResolvedValue(tokenResponse({ error: 'unknown application' }));

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();
    });

    test('returns null when the payload has neither a token nor an error', async () => {
      post.mockResolvedValue(tokenResponse({}));

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('no token in response'));
    });

    test('a response without a base_url is a failed mint', async () => {
      // Without a base URL there is no application environment to cache the
      // token under, so no token is handed back either. Keying on the
      // caller's URL instead would store an entry per resource URL, and
      // nothing here evicts -- a bounded extra request traded for an
      // unbounded leak.
      post.mockResolvedValue(tokenResponse({ token: 'tok-1' }));

      await expect(AccessTokens.token('https://example.com/orders/1')).resolves.toBeNull();
      await expect(AccessTokens.token('https://example.com/orders/2')).resolves.toBeNull();

      expect(AccessTokens.exists('https://example.com/orders/1')).toBe(false);
      // Nothing was cached, so the second call had to ask again.
      expect(post).toHaveBeenCalledTimes(2);
      // Says what actually happened: a broken server, not a bad request.
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('carried a token but no base_url'),
      );
    });

    test('tries again on the next call rather than wedging', async () => {
      // The in-flight promise has to be released even on failure, or one
      // outage would make the process permanently unauthorizable.
      post
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(tokenResponse(tokenPayload('tok-1')));

      await AccessTokens.token(BASE);

      await expect(AccessTokens.token(BASE)).resolves.toBe('tok-1');
    });

    test('caches nothing after a failure', async () => {
      post.mockResolvedValue(null);

      await AccessTokens.token(BASE);

      expect(AccessTokens.exists(BASE)).toBe(false);
    });

    test('a live token is served without asking, so a refused deeper path cannot disturb it', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE);

      await expect(AccessTokens.token(BASE + '/42')).resolves.toBe('tok-1');

      expect(post).toHaveBeenCalledTimes(1);
      expect(AccessTokens.exists(BASE)).toBe(true);
    });

    test('a failed refresh discards the token it could not replace', async () => {
      // Only a token already inside the refresh buffer reaches an exchange,
      // so the one left behind is always close to death. Keeping it means
      // exists() -- whose floor is 30 seconds -- goes on calling it usable,
      // and a caller acting on that presents a credential intake is about to
      // reject.
      post.mockResolvedValueOnce(tokenResponse(tokenPayload('nearly-dead', { expiresInSeconds: 60 })));
      await AccessTokens.token(BASE);

      post.mockResolvedValue(tokenResponse({ error: 'revoked' }));

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();
      expect(AccessTokens.exists(BASE)).toBe(false);
    });

    test('a failure leaves other base URLs untouched', async () => {
      // Only the entry covering the failed URL is dropped. Intake refusing
      // one target must not cost the tokens held for every other target.
      const other = 'https://other.example.com';

      post.mockResolvedValueOnce(tokenResponse(tokenPayload('tok-base', { expiresInSeconds: 60 })));
      await AccessTokens.token(BASE);
      post.mockResolvedValueOnce(tokenResponse(tokenPayload('tok-other', { baseUrl: other })));
      await AccessTokens.token(other);

      post.mockResolvedValue(tokenResponse({ error: 'revoked' }));
      await expect(AccessTokens.token(BASE)).resolves.toBeNull();

      expect(AccessTokens.exists(BASE)).toBe(false);
      expect(AccessTokens.exists(other)).toBe(true);
    });

    test('does not cache the failure', async () => {
      post.mockResolvedValue(null);
      await AccessTokens.token(BASE);

      post.mockResolvedValue(tokenResponse(tokenPayload('tok-recovered')));
      await expect(AccessTokens.token(BASE)).resolves.toBe('tok-recovered');
      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe('expiry given by the service', () => {
    test('an unparseable expiry does not discard an otherwise good token', async () => {
      // Better to hold the token for a default hour than to refetch on every
      // single request because the timestamp was malformed.
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: 'not a date', base_url: BASE }));

      await AccessTokens.token(BASE);

      expect(AccessTokens.exists(BASE)).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });

    test('a missing expiry is treated the same way', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', base_url: BASE }));

      await AccessTokens.token(BASE);

      expect(AccessTokens.exists(BASE)).toBe(true);
    });
  });

  describe('exists', () => {
    test('is false before any token has been issued', () => {
      expect(AccessTokens.exists(BASE)).toBe(false);
    });

    test('is true for a live token', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE);

      expect(AccessTokens.exists(BASE)).toBe(true);
    });

    test('is true for a sub-path of a cached base URL', async () => {
      // `exists` goes through the same prefix matcher `token` does, so a
      // deeper path under a cached base URL reads as covered.
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE);

      expect(AccessTokens.exists(BASE + '/widgets/42')).toBe(true);
    });

    test('is false for a base URL no held token covers', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE);

      expect(AccessTokens.exists('https://elsewhere.example.com')).toBe(false);
    });

    test('is false for a token already past its expiry', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1', { expiresInSeconds: -10 })));
      await AccessTokens.token(BASE);

      expect(AccessTokens.exists(BASE)).toBe(false);
    });
  });

  describe('invalidate', () => {
    test('drops the token the caller was rejected for', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok')));
      const current = await AccessTokens.token(BASE);

      AccessTokens.invalidate(current);

      expect(AccessTokens.exists(BASE)).toBe(false);
    });

    test('finds the entry by token value and drops only that one', async () => {
      // A rejected caller holds a token, not a URL, so the lookup cannot be
      // by base URL -- and the tokens held for other targets are still good.
      const a = 'https://a.example.com';
      const b = 'https://b.example.com';
      const issued = {
        [a]: tokenPayload('tok-a', { baseUrl: a }),
        [b]: tokenPayload('tok-b', { baseUrl: b }),
      };
      post.mockImplementation(async (_url, _auth, body) => tokenResponse(issued[body.base_url]));

      await AccessTokens.token(a);
      await AccessTokens.token(b);

      AccessTokens.invalidate('tok-a');

      expect(AccessTokens.exists(a)).toBe(false);
      expect(AccessTokens.exists(b)).toBe(true);
    });

    test('ignores a token that has already been replaced', async () => {
      // What stops a 401 from stampeding. Every request in flight when a
      // token is rejected reports the same stale value; only the first
      // should cause an exchange, because the rest are holding a token that
      // has already been replaced and clearing for them would discard a good
      // one.
      post
        .mockResolvedValueOnce(tokenResponse(tokenPayload('tok-1')))
        .mockResolvedValueOnce(tokenResponse(tokenPayload('tok-2')));
      const stale = await AccessTokens.token(BASE);
      AccessTokens.invalidate(stale);
      await AccessTokens.token(BASE);

      AccessTokens.invalidate(stale);

      await expect(AccessTokens.token(BASE)).resolves.toBe('tok-2');
      expect(post).toHaveBeenCalledTimes(2);
    });

    test('invalidating nothing is harmless', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE);

      expect(() => AccessTokens.invalidate(null)).not.toThrow();
      expect(() => AccessTokens.invalidate(undefined)).not.toThrow();

      await expect(AccessTokens.token(BASE)).resolves.toBe('tok-1');
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('a nil, undefined, or empty base URL', () => {
    // The match helper only touched its argument once there was something to
    // iterate: a cold cache never runs the loop body, so it can't throw; a
    // warm cache does run it, and `null.startsWith` / `undefined.startsWith`
    // blew up. Same call, two outcomes, decided by unrelated traffic that
    // happened earlier. The warm-cache case is the one that matters -- a
    // cold cache passes today regardless of the fix and proves nothing.
    test.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
    ])('token() does not throw against a warm cache: %s', async (_label, arg) => {
      post.mockResolvedValueOnce(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE); // warm the cache with an unrelated entry

      post.mockResolvedValueOnce(tokenResponse({ error: 'no match' }));

      await expect(AccessTokens.token(arg)).resolves.toBeNull();
    });

    test.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
    ])('exists() does not throw against a warm cache: %s', async (_label, arg) => {
      post.mockResolvedValueOnce(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE); // warm the cache with an unrelated entry

      expect(() => AccessTokens.exists(arg)).not.toThrow();
      expect(AccessTokens.exists(arg)).toBe(false);
    });
  });

  describe('a refresh that resolves to a different base URL', () => {
    test('evicts the stale matched key instead of letting it shadow the fresh one forever', async () => {
      // The success path used to add the new key without removing the one it
      // just matched. When the new canonical base URL is *shorter* than the
      // stale one -- e.g. https://x.com/orders shrinking to https://x.com --
      // the stale, longer key keeps winning the longest-match comparison on
      // every subsequent call, which is unusable, forcing a mint every
      // single time forever. The sharp assertion is therefore not "the old
      // key is gone" (exists() can't tell: the new broad entry covers the
      // same paths the stale narrow one did) but that a third call is served
      // from cache instead of minting a third time.
      const narrow = 'https://example.com/orders';
      const broad = 'https://example.com';
      const freshPayload = tokenResponse(tokenPayload('fresh', { baseUrl: broad }));

      post
        .mockResolvedValueOnce(
          tokenResponse(tokenPayload('stale', { baseUrl: narrow, expiresInSeconds: 60 })),
        )
        .mockResolvedValueOnce(freshPayload)
        .mockResolvedValue(freshPayload);

      await AccessTokens.token(narrow + '/1'); // mints 'stale' under narrow, already inside the refresh buffer
      await expect(AccessTokens.token(narrow + '/1')).resolves.toBe('fresh'); // refresh resolves to the shorter, broad key

      await expect(AccessTokens.token(narrow + '/1')).resolves.toBe('fresh');
      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe('clear', () => {
    test('drops every cached token', async () => {
      const other = 'https://other.example.com';

      post.mockResolvedValueOnce(tokenResponse(tokenPayload('a')));
      await AccessTokens.token(BASE);
      post.mockResolvedValueOnce(tokenResponse(tokenPayload('b', { baseUrl: other })));
      await AccessTokens.token(other);

      AccessTokens.clear();

      expect(AccessTokens.exists(BASE)).toBe(false);
      expect(AccessTokens.exists(other)).toBe(false);
    });
  });
});
