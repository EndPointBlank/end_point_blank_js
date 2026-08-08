'use strict';

/**
 * A fetch Response body can only be consumed once. `EndpointAuthorize.authorize`
 * logs the body on the failure path, and `authorized` then reads it again to
 * build the error the caller sees — so if the first read isn't cloned, every
 * authorization failure reaches the caller as the same generic string and the
 * real reason (access_denied, missing_target_endpoint, invalid_credentials)
 * is lost, both to the API consumer and to whoever is on call.
 */

jest.mock('../src/commands/_http', () => ({ post: jest.fn() }));
jest.mock('../src/authorization', () => ({
  Authorization: { header: jest.fn().mockResolvedValue('Basic dGVzdA==') },
}));

const { post } = require('../src/commands/_http');
const { EndpointAuthorize } = require('../src/commands/endpoint-authorize');
const { authorized } = require('../src/express/authorized');
const { instance: config } = require('../src/configuration');

/** A real Response, so body-consumption semantics are the genuine ones. */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeReq() {
  return {
    method: 'GET',
    baseUrl: '/books',
    route: { path: '/' },
    path: '/',
    url: '/',
    headers: { host: 'example.test' },
    socket: { remoteAddress: '127.0.0.1' },
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  config.appName = 'test-app';
  config.clientId = 'cid';
  config.clientSecret = 'secret';
});

describe('the failure body survives being logged', () => {
  test('authorize leaves the body readable for the caller', async () => {
    post.mockResolvedValue(jsonResponse(401, { authorized: false, error: 'access_denied' }));

    const response = await EndpointAuthorize.authorize(fakeReq(), '/books', null);

    // authorize logs the body itself; if it consumed the original rather than a
    // clone, this read throws and the reason is gone.
    expect(response.bodyUsed).toBe(false);
    await expect(response.json()).resolves.toEqual({
      authorized: false,
      error: 'access_denied',
    });
  });

  test.each([
    ['access_denied', 401],
    ['missing_target_endpoint', 401],
    ['invalid_credentials', 401],
  ])('the middleware surfaces %s rather than a generic string', async (reason, status) => {
    post.mockResolvedValue(jsonResponse(status, { authorized: false, error: reason }));

    const next = jest.fn();
    await authorized(fakeReq(), {}, next);

    const err = next.mock.calls[0][0];
    expect(err.message).toContain(reason);
    expect(err.message).not.toContain('Authorization service unavailable');
    expect(err.statusCode).toBe(status);
  });

  test('a non-JSON error body is surfaced as its text', async () => {
    post.mockResolvedValue(new Response('upstream exploded', { status: 502 }));

    const next = jest.fn();
    await authorized(fakeReq(), {}, next);

    expect(next.mock.calls[0][0].message).toContain('upstream exploded');
  });

  test('an unreachable authorize service still reports unavailable', async () => {
    // The one case the generic message is actually correct for.
    post.mockResolvedValue(null);

    const next = jest.fn();
    await authorized(fakeReq(), {}, next);

    const err = next.mock.calls[0][0];
    expect(err.message).toContain('Authorization service unavailable');
    expect(err.statusCode).toBe(503);
  });
});
