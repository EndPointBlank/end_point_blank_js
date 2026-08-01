'use strict';

jest.mock('../src/commands/_http', () => ({ post: jest.fn() }));
jest.mock('../src/authorization', () => ({
  Authorization: { header: jest.fn(async () => 'Basic dGVzdA==') },
}));

const { post } = require('../src/commands/_http');
const { instance: authCache } = require('../src/commands/authentication-cache');
const { EndpointAuthorize } = require('../src/commands/endpoint-authorize');
const { RequestStore } = require('../src/request-store');

/**
 * Regression: the auth cache key must include the endpoint version.
 *
 * Found by an end-to-end run, not by a unit test. The key was
 * `client_auth:path:method:app_name`, so two callers on different versions of
 * the same route shared one entry — whichever authorized first decided the
 * headers for both. A client on a deprecated version could get no warning, and
 * one on a current version could be told it was retiring.
 *
 * Asserted behaviourally: v1 is deprecated, v2 is not, and each must get its
 * own answer no matter which is called first.
 */
describe('auth cache keys are per endpoint version', () => {
  const req = { headers: { authorization: 'Basic Y2xpZW50' }, method: 'GET', host: 'localhost' };

  const responseFor = version => ({
    status: 201,
    ok: true,
    clone() {
      return this;
    },
    json: async () =>
      version === '1'
        ? { authorized: true, data: [], deprecation: { deprecated_at: '2026-01-01T00:00:00Z' } }
        : { authorized: true, data: [] },
  });

  beforeEach(() => {
    authCache.clear?.();
    post.mockReset();
  });

  const authorizeAs = version =>
    new Promise(resolve => {
      RequestStore.run(req, async () => {
        post.mockResolvedValueOnce(responseFor(version));
        await EndpointAuthorize.authorize(req, '/students', version);
        resolve(RequestStore.getDeprecation());
      });
    });

  test('a v2 call is not served the v1 answer', async () => {
    expect(await authorizeAs('1')).toEqual({ deprecated_at: '2026-01-01T00:00:00Z' });

    // Same client, path and method — only the version differs. Before the fix
    // this was a cache hit and returned v1's deprecation.
    expect(await authorizeAs('2')).toBeNull();

    // Both were authorized for real; neither short-circuited the other.
    expect(post).toHaveBeenCalledTimes(2);
  });

  test('a v1 call is not served the v2 answer', async () => {
    expect(await authorizeAs('2')).toBeNull();
    expect(await authorizeAs('1')).toEqual({ deprecated_at: '2026-01-01T00:00:00Z' });
    expect(post).toHaveBeenCalledTimes(2);
  });

  test('the same version twice is a cache hit and keeps its answer', async () => {
    expect(await authorizeAs('1')).toEqual({ deprecated_at: '2026-01-01T00:00:00Z' });
    expect(await authorizeAs('1')).toEqual({ deprecated_at: '2026-01-01T00:00:00Z' });

    // The second was served from cache — the whole point of caching.
    expect(post).toHaveBeenCalledTimes(1);
  });
});
