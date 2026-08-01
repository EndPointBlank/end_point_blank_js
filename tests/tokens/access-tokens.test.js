'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { AccessTokens } = require('../../src/tokens/access-tokens');

/**
 * Only the network is faked; `GenerateAccessToken` runs for real underneath,
 * so these also cover the request the SDK actually makes for a token.
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

    test('treats hostnames case-insensitively', async () => {
      // DNS is case-insensitive, so `API.Example.test` and `api.example.test`
      // are one host — caching them apart would double every token request.
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await AccessTokens.token('API.Example.TEST');
      await AccessTokens.token('api.example.test');

      expect(post).toHaveBeenCalledTimes(1);
    });

    test('keeps a separate token per hostname', async () => {
      post
        .mockResolvedValueOnce(tokenResponse({ token: 'tok-a', expired_at: secondsFromNow(3600) }))
        .mockResolvedValueOnce(tokenResponse({ token: 'tok-b', expired_at: secondsFromNow(3600) }));

      await expect(AccessTokens.token('a.example.test')).resolves.toBe('tok-a');
      await expect(AccessTokens.token('b.example.test')).resolves.toBe('tok-b');
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
    test('a burst of requests for one host triggers a single token fetch', async () => {
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

    test('different hosts are fetched independently', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok', expired_at: secondsFromNow(3600) }));

      await Promise.all([AccessTokens.token('a.example.test'), AccessTokens.token('b.example.test')]);

      expect(post).toHaveBeenCalledTimes(2);
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
      // outage would make the host permanently unauthorizable.
      post
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));

      await AccessTokens.token('api.example.test');

      await expect(AccessTokens.token('api.example.test')).resolves.toBe('tok-1');
    });

    test('caches nothing after a failure', async () => {
      post.mockResolvedValue(null);

      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists('api.example.test')).toBe(false);
    });
  });

  describe('expiry given by the service', () => {
    test('an unparseable expiry does not discard an otherwise good token', async () => {
      // Better to hold the token for a default hour than to refetch on every
      // single request because the timestamp was malformed.
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: 'not a date' }));

      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists('api.example.test')).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });

    test('a missing expiry is treated the same way', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1' }));

      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists('api.example.test')).toBe(true);
    });
  });

  describe('exists', () => {
    test('is false for a host never seen', () => {
      expect(AccessTokens.exists('api.example.test')).toBe(false);
    });

    test('is true for a live token', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists('api.example.test')).toBe(true);
    });

    test('is false for a token already past its expiry', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok-1', expired_at: secondsFromNow(-10) }));
      await AccessTokens.token('api.example.test');

      expect(AccessTokens.exists('api.example.test')).toBe(false);
    });
  });

  describe('eviction', () => {
    test('remove forgets the token for one host only', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('a.example.test');
      await AccessTokens.token('b.example.test');

      AccessTokens.remove('a.example.test');

      expect(AccessTokens.exists('a.example.test')).toBe(false);
      expect(AccessTokens.exists('b.example.test')).toBe(true);
    });

    test('remove is case-insensitive, so a stale token really goes', async () => {
      // The 401 retry removes by the hostname it read off the request, which
      // may differ in case from the one the token was cached under. If that
      // missed, the retry would present the same dead token again.
      post.mockResolvedValue(tokenResponse({ token: 'tok', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('api.example.test');

      AccessTokens.remove('API.EXAMPLE.TEST');

      expect(AccessTokens.exists('api.example.test')).toBe(false);
    });

    test('remove of an unknown host is harmless', () => {
      expect(() => AccessTokens.remove('nobody.example.test')).not.toThrow();
    });

    test('clear forgets every host', async () => {
      post.mockResolvedValue(tokenResponse({ token: 'tok', expired_at: secondsFromNow(3600) }));
      await AccessTokens.token('a.example.test');
      await AccessTokens.token('b.example.test');

      AccessTokens.clear();

      expect(AccessTokens.exists('a.example.test')).toBe(false);
      expect(AccessTokens.exists('b.example.test')).toBe(false);
    });
  });
});
