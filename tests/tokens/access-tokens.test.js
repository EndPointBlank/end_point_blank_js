'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { AccessTokens } = require('../../src/tokens/access-tokens');
const { TokenOutcome } = require('../../src/commands/generate-access-token');

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

/** A non-2xx answer from intake, with the status it actually uses. */
const errorResponse = (status, body = {}) => ({
  status,
  ok: false,
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

    test('a failing concurrent mint does not evict a good entry for a different URL under the same environment', async () => {
      // _inflight coalesces by the caller's URL, not by environment, so two
      // different URLs under one environment run as two separate concurrent
      // exchanges. If the matched key were recomputed after the await instead
      // of captured before it, a slower failing call could see (and delete)
      // the entry a faster concurrent call already stored for the same
      // environment.
      const widget = 'https://example.com/orders/widgets/42';
      const other = 'https://example.com/orders/anything';
      const envBase = 'https://example.com/orders';

      let resolveFail;
      let resolveGood;
      const pendingFail = new Promise(resolve => {
        resolveFail = resolve;
      });
      const pendingGood = new Promise(resolve => {
        resolveGood = resolve;
      });

      post.mockImplementation(async (_url, _auth, body) =>
        body.base_url === widget ? pendingFail : pendingGood,
      );

      const call1 = AccessTokens.token(widget); // slow, will fail
      const call2 = AccessTokens.token(other); // fast, will succeed

      // The fast call settles first and stores its entry.
      resolveGood(tokenResponse(tokenPayload('tok-good', { baseUrl: envBase })));
      await expect(call2).resolves.toBe('tok-good');

      // The slow call fails *after* the good entry is already stored.
      resolveFail(tokenResponse({ error: 'transient 5xx' }));
      await expect(call1).resolves.toBeNull();

      // The good entry must survive the unrelated, concurrent failure.
      expect(AccessTokens.exists(envBase)).toBe(true);
      expect(AccessTokens.exists(other)).toBe(true);
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

  describe('telling a rejected credential apart from a failing service', () => {
    // intake answers 401 for a credential it will not accept, and something
    // else for everything it might accept later. A caller that cannot see the
    // difference either retries a request that can never succeed or gives up
    // on one that would have.

    test('says the credential was rejected, in its own line, not the generic failure one', async () => {
      post.mockResolvedValue(errorResponse(401, { error: 'invalid credentials' }));

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();

      const logged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toMatch(/rejected/i);
      expect(logged).toMatch(/re-issue/i);
      expect(logged).not.toContain('Failed to generate access token');
    });

    test('records the rejection so a caller can ask why it got null', async () => {
      post.mockResolvedValue(errorResponse(401, { error: 'invalid credentials' }));

      await AccessTokens.token(BASE);

      expect(AccessTokens.lastFailure(BASE)).toEqual({
        outcome: TokenOutcome.CREDENTIAL_REJECTED,
        status: 401,
      });
    });

    test('still evicts the entry it could not refresh, exactly as any other failure does', async () => {
      // A rejected credential is the one case where the held token is
      // certainly dead, so the eviction that protects every other failure
      // must not be skipped for it.
      post.mockResolvedValueOnce(tokenResponse(tokenPayload('nearly-dead', { expiresInSeconds: 60 })));
      await AccessTokens.token(BASE);

      post.mockResolvedValue(errorResponse(401, { error: 'revoked' }));

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();
      expect(AccessTokens.exists(BASE)).toBe(false);
    });

    test('still coalesces a burst behind one exchange', async () => {
      // Ten callers hitting a revoked credential must produce one 401, not
      // ten: the branch on the outcome runs after the coalescing, not
      // instead of it.
      let release;
      const pending = new Promise(resolve => {
        release = resolve;
      });
      post.mockImplementation(() => pending);

      const callers = Promise.all(Array.from({ length: 10 }, () => AccessTokens.token(BASE)));
      release(errorResponse(401, { error: 'invalid credentials' }));

      await expect(callers).resolves.toEqual(Array(10).fill(null));
      expect(post).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['a malformed request', 400, TokenOutcome.REQUEST_REJECTED],
      ['an unregistered target application', 422, TokenOutcome.REQUEST_REJECTED],
      ['a failing service', 500, TokenOutcome.SERVER_ERROR],
      ['a bad gateway', 502, TokenOutcome.SERVER_ERROR],
    ])('records %s as %i, distinctly from a rejected credential', async (_label, status, outcome) => {
      post.mockResolvedValue(errorResponse(status, { error: 'nope' }));

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();

      expect(AccessTokens.lastFailure(BASE)).toEqual({ outcome, status });
      // The loud credential line belongs to 401 alone.
      const logged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toContain('Failed to generate access token');
    });

    test('records an unreachable service as a transport failure with no status', async () => {
      post.mockResolvedValue(null);

      await AccessTokens.token(BASE);

      expect(AccessTokens.lastFailure(BASE)).toEqual({
        outcome: TokenOutcome.TRANSPORT_ERROR,
        status: null,
      });
    });

    test('a 401 an unreadable body still reads as a rejected credential', async () => {
      // The SDK reaches intake through Caddy; a proxy, WAF or auth gateway in
      // front of the app can answer 401 with an HTML page intake never
      // generated. The credential is genuinely being refused, so this must
      // not land in the retry-me bucket just because the body was not JSON.
      post.mockResolvedValue({
        status: 401,
        ok: false,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();

      expect(AccessTokens.lastFailure(BASE)).toEqual({
        outcome: TokenOutcome.CREDENTIAL_REJECTED,
        status: 401,
      });
      const logged = console.error.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).toMatch(/rejected/i);
    });

    test('records a body it could not read under the status that came with it', async () => {
      post.mockResolvedValue({
        status: 502,
        ok: false,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();

      expect(AccessTokens.lastFailure(BASE)).toEqual({
        outcome: TokenOutcome.SERVER_ERROR,
        status: 502,
      });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('HTTP 502 (unreadable body)'),
      );
    });

    test('logs the bare status when the refusal came with no reason of its own', async () => {
      post.mockResolvedValue(errorResponse(503));

      await AccessTokens.token(BASE);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    });

    test('survives a 2xx whose body is a bare null', async () => {
      // `json()` resolving to literal null is still a parsed body, so it
      // reaches the code that reads a token out of it. Reading through it
      // would throw inside the caller's own request.
      post.mockResolvedValue(tokenResponse(null));

      await expect(AccessTokens.token(BASE)).resolves.toBeNull();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('no response'));
    });

    test('records a 2xx whose body carries no usable token as a broken server', async () => {
      // intake's base_url is NOT NULL, so a 201 without one is the server
      // misbehaving rather than anything the caller can fix -- which puts it
      // with the retriable failures, not with the rejections.
      post.mockResolvedValue(tokenResponse({ token: 'tok-1' }));

      await AccessTokens.token(BASE);

      expect(AccessTokens.lastFailure(BASE)).toEqual({
        outcome: TokenOutcome.SERVER_ERROR,
        status: 201,
      });
    });
  });

  describe('lastFailure', () => {
    test('is null before anything has been attempted', () => {
      expect(AccessTokens.lastFailure(BASE)).toBeNull();
    });

    test('is null after a token was minted', async () => {
      post.mockResolvedValue(tokenResponse(tokenPayload('tok-1')));

      await AccessTokens.token(BASE);

      expect(AccessTokens.lastFailure(BASE)).toBeNull();
    });

    test('is cleared by a later success, so it never reports a resolved outage', async () => {
      post.mockResolvedValueOnce(errorResponse(503, { error: 'down' }));
      await AccessTokens.token(BASE);
      expect(AccessTokens.lastFailure(BASE)).not.toBeNull();

      post.mockResolvedValueOnce(tokenResponse(tokenPayload('tok-1')));
      await AccessTokens.token(BASE);

      expect(AccessTokens.lastFailure(BASE)).toBeNull();
    });

    test('answers for the URL that was asked for, not for every URL', async () => {
      const other = 'https://other.example.com';
      post.mockImplementation(async (_url, _auth, body) =>
        body.base_url === BASE ? errorResponse(401, { error: 'nope' }) : errorResponse(500, {}),
      );

      await AccessTokens.token(BASE);
      await AccessTokens.token(other);

      expect(AccessTokens.lastFailure(BASE)).toEqual({
        outcome: TokenOutcome.CREDENTIAL_REJECTED,
        status: 401,
      });
      expect(AccessTokens.lastFailure(other)).toEqual({
        outcome: TokenOutcome.SERVER_ERROR,
        status: 500,
      });
      expect(AccessTokens.lastFailure('https://never-asked.example.com')).toBeNull();
    });

    test('keeps the most recent failure for a URL, not the first', async () => {
      post.mockResolvedValueOnce(errorResponse(500, {}));
      await AccessTokens.token(BASE);

      post.mockResolvedValueOnce(errorResponse(401, {}));
      await AccessTokens.token(BASE);

      expect(AccessTokens.lastFailure(BASE)).toEqual({
        outcome: TokenOutcome.CREDENTIAL_REJECTED,
        status: 401,
      });
    });

    test('does not grow without bound when every URL a service walks fails', async () => {
      // A service walking /orders/1, /orders/2, ... against a dead intake
      // must not accumulate one record per resource URL forever; the same
      // unbounded-growth trap the token cache avoids by keying on the
      // environment. The newest records survive, the oldest are dropped.
      post.mockResolvedValue(errorResponse(500, {}));

      for (let i = 0; i < 200; i++) {
        await AccessTokens.token(`https://example.com/orders/${i}`);
      }

      expect(AccessTokens.lastFailure('https://example.com/orders/199')).not.toBeNull();
      expect(AccessTokens.lastFailure('https://example.com/orders/0')).toBeNull();
    });

    test('is forgotten by clear(), along with the tokens', async () => {
      post.mockResolvedValue(errorResponse(500, {}));
      await AccessTokens.token(BASE);

      AccessTokens.clear();

      expect(AccessTokens.lastFailure(BASE)).toBeNull();
    });

    test('is null for a nil, undefined or empty URL rather than throwing', () => {
      expect(AccessTokens.lastFailure(null)).toBeNull();
      expect(AccessTokens.lastFailure(undefined)).toBeNull();
      expect(AccessTokens.lastFailure('')).toBeNull();
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
