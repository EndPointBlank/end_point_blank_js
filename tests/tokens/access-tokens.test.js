'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { AccessTokens } = require('../../src/tokens/access-tokens');

/**
 * Only the network is faked; `GenerateAccessToken` runs for real underneath,
 * so these also cover the request the SDK actually makes for a token.
 *
 * Intake issues a token against the application environment the authenticating
 * credential belongs to, not against the hostname the request names. One
 * process authenticates as one application environment, so it holds one token
 * and the hostname is only ever part of the generation payload.
 */

const secondsFromNow = seconds => new Date(Date.now() + seconds * 1000).toISOString();

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

  describe('fetching', () => {
    test('returns the token the service issued', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await expect(AccessTokens.token('api.example.test')).resolves.toBe('tok-1');
    });

    test('asks for a token for the hostname being called', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await AccessTokens.token('api.example.test');

      expect(post.mock.calls[0][2]).toEqual({ hostname: 'api.example.test' });
    });

    test('reuses a live token instead of asking again', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await AccessTokens.token('api.example.test');
      await AccessTokens.token('api.example.test');

      expect(post).toHaveBeenCalledTimes(1);
    });

    test('serves every hostname from the one token', async () => {
      // The hostname arrives on the Host header, so the caller chooses it.
      // Caching per hostname meant a novel value cost a token exchange and a
      // database lookup on intake, for a token never scoped to the hostname.
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await expect(AccessTokens.token('a.example.test')).resolves.toBe('tok-1');
      await expect(AccessTokens.token('b.example.test')).resolves.toBe('tok-1');
      await expect(AccessTokens.token('never.seen.example.test')).resolves.toBe('tok-1');

      expect(post).toHaveBeenCalledTimes(1);
    });

    test('renews a token that is about to expire rather than presenting it', async () => {
      // A token with a minute left will very likely be dead by the time the
      // authorize call lands, so it is refreshed inside a two-minute buffer.
      post
        .mockResolvedValueOnce(tokenResponse({ token: 'nearly-dead', expired_at: secondsFromNow(60) }))
        .mockResolvedValueOnce(tokenResponse({ token: 'fresh', expired_at: secondsFromNow(3600) }));

      await AccessTokens.token('api.example.test');

      await expect(AccessTokens.token('api.example.test')).resolves.toBe('fresh');
    });
  });

  describe('concurrent callers', () => {
    test('a burst of requests triggers a single token fetch', async () => {
      // Every inbound request needs a token. Without coalescing, a cold start
      // under load stampedes the token endpoint with one call per request.
      let release;
      const pending = new Promise(resolve => {
        release = resolve;
      });
      post.mockImplementation(() => pending);

      const callers = Promise.all(
        Array.from({ length: 10 }, () => AccessTokens.token('api.example.test')),
      );

      release(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await expect(callers).resolves.toEqual(Array(10).fill('tok-1'));
      expect(post).toHaveBeenCalledTimes(1);
    });

    test('a burst across different hosts also triggers a single token fetch', async () => {
      let release;
      const pending = new Promise(resolve => {
        release = resolve;
      });
      post.mockImplementation(() => pending);

      const callers = Promise.all([
        AccessTokens.token('a.example.test'),
        AccessTokens.token('b.example.test'),
        AccessTokens.token('c.example.test'),
      ]);

      release(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await expect(callers).resolves.toEqual(['tok-1', 'tok-1', 'tok-1']);
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('when a token cannot be obtained', () => {
    test('returns null when the service is unreachable', async () => {
      post.mockResolvedValue(null);

      await expect(AccessTokens.token('api.example.test')).resolves.toBeNull();
    });

    test('returns null when the service answers without a token', async () => {
      post.mockResolvedValue(tokenResponse({ error: 'unknown application' }));

      await expect(AccessTokens.token('api.example.test')).resolves.toBeNull();
    });

    test('tries again on the next call rather than wedging', async () => {
      // The in-flight promise has to be released even on failure, or one
      // outage would make the process permanently unauthorizable.
      post
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await AccessTokens.token('api.example.test');

      await expect(AccessTokens.token('api.example.test')).resolves.toBe('tok-1');
    });

    test('caches nothing after a failure', async () => {
      post.mockResolvedValue(null);

      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists()).toBe(false);
    });

    test('a live token is served without asking, so a refused host cannot disturb it', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('api.example.test');

      await expect(AccessTokens.token('bogus.example.test')).resolves.toBe('tok-1');

      expect(post).toHaveBeenCalledTimes(1);
      expect(AccessTokens.exists()).toBe(true);
    });
  });

  describe('expiry given by the service', () => {
    test('an unparseable expiry does not discard an otherwise good token', async () => {
      // Better to hold the token for a default hour than to refetch on every
      // single request because the timestamp was malformed.
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: 'not a date' }));

      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists()).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });

    test('a missing expiry is treated the same way', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1' }));

      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists()).toBe(true);
    });
  });

  describe('exists', () => {
    test('is false before any token has been issued', () => {
      expect(AccessTokens.exists()).toBe(false);
    });

    test('is true for a live token', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists()).toBe(true);
    });

    test('is false for a token already past its expiry', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(-10) }));
      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists()).toBe(false);
    });
  });

  describe('invalidate', () => {
    test('drops the token the caller was rejected for', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok', expired_at: secondsFromNow(3600) }));
      const current = await AccessTokens.token('api.example.test');

      AccessTokens.invalidate(current);

      expect(AccessTokens.exists()).toBe(false);
    });

    test('ignores a token that has already been replaced', async () => {
      // What stops a 401 from stampeding. Every request in flight when a token
      // is rejected reports the same stale value; only the first should cause
      // an exchange, because the rest are holding a token that has already been
      // replaced and clearing for them would discard a good one.
      post
        .mockResolvedValueOnce(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }))
        .mockResolvedValueOnce(tokenResponse({ token: 'tok-2', expired_at: secondsFromNow(3600) }));
      const stale = await AccessTokens.token('api.example.test');
      AccessTokens.invalidate(stale);
      await AccessTokens.token('api.example.test');

      AccessTokens.invalidate(stale);

      await expect(AccessTokens.token('api.example.test')).resolves.toBe('tok-2');
      expect(post).toHaveBeenCalledTimes(2);
    });

    test('invalidating nothing is harmless', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('api.example.test');

      expect(() => AccessTokens.invalidate(null)).not.toThrow();
      expect(() => AccessTokens.invalidate(undefined)).not.toThrow();

      await expect(AccessTokens.token('api.example.test')).resolves.toBe('tok-1');
      expect(post).toHaveBeenCalledTimes(1);
    });

    test('clear forgets the token', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('a.example.test');

      AccessTokens.clear();

      expect(AccessTokens.exists()).toBe(false);
    });
  });
});
