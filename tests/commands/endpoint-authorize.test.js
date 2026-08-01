'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { instance: authCache } = require('../../src/commands/authentication-cache');
const { AccessTokens } = require('../../src/tokens/access-tokens');
const { EndpointAuthorize } = require('../../src/commands/endpoint-authorize');
const { RequestStore } = require('../../src/request-store');

/**
 * Everything below `post` is real: `Authorization`, `AccessTokens` and
 * `GenerateAccessToken` all run, so the credential exchange is exercised
 * end-to-end and only the network is faked. That is what makes the expired
 * -token retry assertable — a stubbed `Authorization.header` would hand back
 * the same string twice and hide the whole point of the retry.
 */

const HOUR_FROM_NOW = () => new Date(Date.now() + 3600 * 1000).toISOString();

// A `fetch` Response can only be read once. Modelling that is the point: the
// success path reads the body to pull the deprecation block out of it, and a
// caller that reads it afterwards must still get a body rather than a
// "already consumed" TypeError.
const jsonResponse = (status, body) => {
  let consumed = false;
  const read = () => {
    if (consumed) throw new TypeError('Body has already been consumed.');
    consumed = true;
    return body;
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    clone: () => jsonResponse(status, body),
    json: async () => JSON.parse(JSON.stringify(read())),
    text: async () => JSON.stringify(read()),
  };
};

// A 201 with nothing in it. Real `Response.json()` rejects on an empty body.
const emptyResponse = (status = 201) => ({
  status,
  ok: status >= 200 && status < 300,
  clone() {
    return this;
  },
  json: async () => {
    throw new SyntaxError('Unexpected end of JSON input');
  },
  text: async () => '',
});

const DEPRECATION = { deprecated_at: '2026-01-01T00:00:00Z', sunset_at: '2026-11-11T11:11:11Z' };

describe('EndpointAuthorize.authorize', () => {
  let api;

  const req = (overrides = {}) => ({
    headers: { authorization: 'Basic Y2xpZW50', host: 'api.example.test', ...overrides.headers },
    method: 'GET',
    ...overrides,
  });

  // Resolves once the authorize call has finished *and* the per-request store
  // has been read, since the deprecation only exists inside the request context.
  const authorize = (request, path = '/students', version = '1') =>
    new Promise((resolve, reject) => {
      RequestStore.run(request, async () => {
        try {
          const response = await EndpointAuthorize.authorize(request, path, version);
          resolve({ response, deprecation: RequestStore.getDeprecation() });
        } catch (err) {
          reject(err);
        }
      });
    });

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.baseUrl = 'https://epb.test';

    authCache.clear();
    AccessTokens.clear();

    let issued = 0;
    api = {
      tokens: () => jsonResponse(201, { token: `tok-${++issued}`, expired_at: HOUR_FROM_NOW() }),
      authorizeQueue: [],
      calls: { token: [], authorize: [] },
    };

    post.mockReset();
    post.mockImplementation(async (url, authHeader, body) => {
      if (url === config.accessTokenUrl) {
        api.calls.token.push({ authHeader, body });
        return api.tokens();
      }
      api.calls.authorize.push({ authHeader, body });
      return api.authorizeQueue.length
        ? api.authorizeQueue.shift()
        : jsonResponse(201, { authorized: true });
    });

    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  describe('the authorize request it sends', () => {
    test('describes the call being made', async () => {
      await authorize(req(), '/students/:id', '2');

      expect(api.calls.authorize[0].body).toMatchObject({
        path: '/students/:id',
        http_method: 'GET',
        client_auth: 'Basic Y2xpZW50',
        application: 'billing',
        endpoint_version: '2',
      });
    });

    test('strips the port from the target hostname', async () => {
      // The portal identifies an application environment by hostname. A local
      // or containerised app sees `Host: api.example.test:3000`, which would
      // otherwise never match the registered environment.
      await authorize(req({ headers: { host: 'api.example.test:3000' } }));

      expect(api.calls.authorize[0].body.target_hostname).toBe('api.example.test');
    });

    test('sends an empty client auth rather than nothing when the caller is anonymous', async () => {
      const anonymous = req();
      delete anonymous.headers.authorization;

      await authorize(anonymous);

      expect(api.calls.authorize[0].body.client_auth).toBe('');
    });

    describe('the source IP', () => {
      test('is the original client when the request came through a proxy', async () => {
        // Behind a load balancer every request appears to come from the
        // balancer, so the first forwarded entry is the only real client IP.
        await authorize(req({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }));

        expect(api.calls.authorize[0].body.source_ip).toBe('203.0.113.7');
      });

      test('is the socket address when there is no proxy header', async () => {
        await authorize(req({ socket: { remoteAddress: '198.51.100.4' } }));

        expect(api.calls.authorize[0].body.source_ip).toBe('198.51.100.4');
      });

      test('falls back to the framework-resolved IP', async () => {
        await authorize(req({ ip: '192.0.2.9' }));

        expect(api.calls.authorize[0].body.source_ip).toBe('192.0.2.9');
      });

      test('is null when nothing identifies the caller', async () => {
        await authorize(req());

        expect(api.calls.authorize[0].body.source_ip).toBeNull();
      });
    });
  });

  describe('caching an authorization', () => {
    test('answers a repeat of the same call without going to the network', async () => {
      await authorize(req(), '/students', '1');
      await authorize(req(), '/students', '1');

      expect(api.calls.authorize).toHaveLength(1);
    });

    test('reports success on a cache hit', async () => {
      await authorize(req(), '/students', '1');

      const { response } = await authorize(req(), '/students', '1');

      expect(response.status).toBe(201);
      expect(response.ok).toBe(true);
    });

    test('replays the deprecation on every cache hit, not just the first', async () => {
      // Authorization is cached per client and route, so a marker-only cache
      // would limit the Deprecation header to cache misses — roughly one
      // request in N, which reads as a flaky feature rather than a missing one.
      api.authorizeQueue.push(jsonResponse(201, { authorized: true, deprecation: DEPRECATION }));

      const first = await authorize(req(), '/students', '1');
      const second = await authorize(req(), '/students', '1');
      const third = await authorize(req(), '/students', '1');

      expect(first.deprecation).toEqual(DEPRECATION);
      expect(second.deprecation).toEqual(DEPRECATION);
      expect(third.deprecation).toEqual(DEPRECATION);
      expect(api.calls.authorize).toHaveLength(1);
    });

    test('caches "authorized and not deprecated" too', async () => {
      // A non-deprecated success has no block to store, so it needs a truthy
      // marker of its own — the cache declines to store falsy values, and
      // without the marker every such request would miss and re-authorize.
      await authorize(req(), '/students', '1');

      const { deprecation } = await authorize(req(), '/students', '1');

      expect(api.calls.authorize).toHaveLength(1);
      expect(deprecation).toBeNull();
    });

    test('does not let one client use another client\'s authorization', async () => {
      await authorize(req({ headers: { authorization: 'Basic YWxpY2U=' } }));
      await authorize(req({ headers: { authorization: 'Basic Ym9i' } }));

      expect(api.calls.authorize).toHaveLength(2);
    });

    test('does not let an anonymous caller inherit an authenticated one', async () => {
      const anonymous = req();
      delete anonymous.headers.authorization;

      await authorize(req());
      await authorize(anonymous);

      expect(api.calls.authorize).toHaveLength(2);
    });

    test('authorizes each path separately', async () => {
      await authorize(req(), '/students', '1');
      await authorize(req(), '/teachers', '1');

      expect(api.calls.authorize).toHaveLength(2);
    });

    test('authorizes each HTTP method separately', async () => {
      // Read access is not write access; sharing a cache entry across methods
      // would let a GET-authorized client through on DELETE.
      await authorize(req({ method: 'GET' }), '/students', '1');
      await authorize(req({ method: 'DELETE' }), '/students', '1');

      expect(api.calls.authorize).toHaveLength(2);
    });

    test('authorizes each application separately', async () => {
      await authorize(req(), '/students', '1');
      config.appName = 'reporting';
      await authorize(req(), '/students', '1');

      expect(api.calls.authorize).toHaveLength(2);
    });

    test('does not cache a refusal', async () => {
      // A denial must not stick: a client granted access a second later would
      // otherwise stay locked out for the whole cache TTL.
      api.authorizeQueue.push(jsonResponse(403, { error: 'denied' }));

      await authorize(req(), '/students', '1');
      await authorize(req(), '/students', '1');

      expect(api.calls.authorize).toHaveLength(2);
    });
  });

  describe('the deprecation block', () => {
    test('is taken from the authorize response', async () => {
      api.authorizeQueue.push(jsonResponse(201, { authorized: true, deprecation: DEPRECATION }));

      const { deprecation } = await authorize(req());

      expect(deprecation).toEqual(DEPRECATION);
    });

    test('is null when the version is current', async () => {
      const { deprecation } = await authorize(req());

      expect(deprecation).toBeNull();
    });

    test('is null when the response has no body at all', async () => {
      // Regression: an empty 201 body made `JSON.parse` throw, turning a
      // successful authorization into a 500 on the customer's request.
      api.authorizeQueue.push(emptyResponse(201));

      const { response, deprecation } = await authorize(req());

      expect(deprecation).toBeNull();
      expect(response.status).toBe(201);
    });

    test('is null when the response body is not the shape we expect', async () => {
      api.authorizeQueue.push(jsonResponse(201, ['not', 'an', 'object']));

      const { deprecation } = await authorize(req());

      expect(deprecation).toBeNull();
    });

    test('leaves the response body readable by the caller', async () => {
      // A `fetch` body can only be consumed once. Reading it here to extract
      // the deprecation must not drain it for the middleware downstream.
      api.authorizeQueue.push(jsonResponse(201, { authorized: true, deprecation: DEPRECATION }));

      const { response } = await authorize(req());

      await expect(response.json()).resolves.toEqual({
        authorized: true,
        deprecation: DEPRECATION,
      });
    });
  });

  describe('when the access token has expired', () => {
    test('discards the stale token and retries with a fresh one', async () => {
      // Tokens expire server-side ahead of the client's own clock. Without the
      // retry the SDK would keep presenting the dead token and refuse every
      // request until its cached copy lapsed.
      api.authorizeQueue.push(jsonResponse(401, { error: 'token expired' }));

      const { response } = await authorize(req());

      expect(api.calls.authorize.map(c => c.authHeader)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
      expect(response.status).toBe(201);
    });

    test('re-fetches the token rather than reusing the cached one', async () => {
      api.authorizeQueue.push(jsonResponse(401, { error: 'token expired' }));

      await authorize(req());

      expect(api.calls.token).toHaveLength(2);
      expect(AccessTokens.exists('api.example.test')).toBe(true);
    });

    test('caches the authorization the retry earned', async () => {
      api.authorizeQueue.push(jsonResponse(401, { error: 'token expired' }));
      api.authorizeQueue.push(jsonResponse(201, { authorized: true, deprecation: DEPRECATION }));

      await authorize(req(), '/students', '1');
      const { deprecation } = await authorize(req(), '/students', '1');

      expect(deprecation).toEqual(DEPRECATION);
      expect(api.calls.authorize).toHaveLength(2);
    });

    test('gives up rather than looping when the retry is also refused', async () => {
      api.authorizeQueue.push(jsonResponse(401, { error: 'token expired' }));
      api.authorizeQueue.push(jsonResponse(401, { error: 'still no' }));

      const { response } = await authorize(req());

      expect(response.status).toBe(401);
      expect(api.calls.authorize).toHaveLength(2);
    });

    test('does not retry a 401 earned by Basic credentials', async () => {
      // Basic credentials are configuration, not a cache. Retrying them would
      // double every rejected request against a misconfigured client id.
      api.tokens = () => null;
      api.authorizeQueue.push(jsonResponse(401, { error: 'bad credentials' }));

      const { response } = await authorize(req());

      expect(api.calls.authorize).toHaveLength(1);
      expect(api.calls.authorize[0].authHeader.startsWith('Basic ')).toBe(true);
      expect(response.status).toBe(401);
    });
  });

  describe('when the authorize service does not answer', () => {
    test('returns null so the caller can decide what to do', async () => {
      api.authorizeQueue.push(null);

      const { response } = await authorize(req());

      expect(response).toBeNull();
    });

    test('caches nothing, so the next request tries again', async () => {
      // Caching an outage would extend a momentary blip into a TTL-long one.
      api.authorizeQueue.push(null);

      await authorize(req(), '/students', '1');
      await authorize(req(), '/students', '1');

      expect(api.calls.authorize).toHaveLength(2);
    });
  });

  describe('when the service refuses', () => {
    test('hands the refusal back to the caller unchanged', async () => {
      api.authorizeQueue.push(jsonResponse(403, { error: 'denied' }));

      const { response } = await authorize(req());

      expect(response.status).toBe(403);
    });

    test('records no deprecation for a refused request', async () => {
      api.authorizeQueue.push(jsonResponse(403, { error: 'denied' }));

      const { deprecation } = await authorize(req());

      expect(deprecation).toBeNull();
    });

    test('survives a refusal whose body cannot be read', async () => {
      api.authorizeQueue.push({
        status: 500,
        ok: false,
        text: async () => {
          throw new TypeError('terminated');
        },
      });

      const { response } = await authorize(req());

      expect(response.status).toBe(500);
    });
  });
});
