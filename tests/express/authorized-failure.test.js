'use strict';

jest.mock('../../src/commands/endpoint-authorize', () => ({
  EndpointAuthorize: { authorize: jest.fn() },
}));

const { EndpointAuthorize } = require('../../src/commands/endpoint-authorize');
const { UnauthorizedError } = require('../../src/unauthorized-error');
const { authorized } = require('../../src/express/authorized');

/**
 * The happy path and the deprecation headers are covered in
 * `authorized-deprecation.test.js`. This is about what happens when
 * authorization does not succeed — the decision to let a request through is
 * the one the SDK must never get wrong.
 */
describe('authorized middleware — refusals and faults', () => {
  const req = {
    headers: {},
    baseUrl: '/api',
    route: { path: '/students/:id' },
    method: 'GET',
  };

  const run = async () => {
    const next = jest.fn();
    await authorized(req, { setHeader: () => {}, headersSent: false }, next);
    return next;
  };

  beforeEach(() => {
    EndpointAuthorize.authorize.mockReset();
  });

  test('asks about the fully mounted path, not the router-relative one', async () => {
    // A router mounted at `/api` sees `/students/:id`; the portal registered
    // `/api/students/:id`. Dropping the mount point misses every match.
    EndpointAuthorize.authorize.mockResolvedValue({ status: 201, ok: true });

    await run();

    expect(EndpointAuthorize.authorize.mock.calls[0][1]).toBe('/api/students/:id');
  });

  describe('when no route pattern is available', () => {
    const runWith = async request => {
      EndpointAuthorize.authorize.mockResolvedValue({ status: 201, ok: true });
      await authorized(request, { setHeader: () => {}, headersSent: false }, jest.fn());
      return EndpointAuthorize.authorize.mock.calls[0][1];
    };

    test('falls back to the request path', async () => {
      // `router.use(authorized)` runs before a route is matched, so there is
      // no pattern yet — the request must still be authorized against something.
      const path = await runWith({ headers: {}, baseUrl: '/api', path: '/students', method: 'GET' });

      expect(path).toBe('/api/students');
    });

    test('falls back to the raw URL when there is no path either', async () => {
      const path = await runWith({ headers: {}, baseUrl: '', url: '/students?q=1', method: 'GET' });

      expect(path).toBe('/students?q=1');
    });
  });

  describe('a refused request', () => {
    beforeEach(() => {
      EndpointAuthorize.authorize.mockResolvedValue({
        status: 403,
        json: async () => ({ error: 'not entitled' }),
        text: async () => 'not entitled',
      });
    });

    test('never reaches the route', async () => {
      const next = await run();

      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    });

    test('keeps the status the service decided on', async () => {
      // A 403 is not a 401: answering "unauthenticated" to an authenticated
      // caller who simply lacks entitlement sends them round a login loop.
      const next = await run();

      expect(next.mock.calls[0][0].statusCode).toBe(403);
    });

    test('explains itself using the reason the service gave', async () => {
      const next = await run();

      expect(next.mock.calls[0][0].message).toContain('not entitled');
    });
  });

  test('falls back to the raw response text when the service did not send JSON', async () => {
    EndpointAuthorize.authorize.mockResolvedValue({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      text: async () => 'Bad Gateway',
    });

    const next = await run();

    expect(next.mock.calls[0][0].message).toContain('Bad Gateway');
  });

  test('still explains itself when the response body cannot be read at all', async () => {
    // `authorized` reads the body twice on the failure path, and a `fetch`
    // body can only be consumed once — so the second read routinely fails.
    EndpointAuthorize.authorize.mockResolvedValue({
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
      text: async () => {
        throw new TypeError('Body has already been consumed.');
      },
    });

    const next = await run();

    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    expect(next.mock.calls[0][0].message).toBeTruthy();
    expect(next.mock.calls[0][0].statusCode).toBe(500);
  });

  test('reports a service outage as 503 rather than a refusal', async () => {
    // Nothing was decided about this caller, so it is the service that is
    // unavailable, not the caller who is forbidden.
    EndpointAuthorize.authorize.mockResolvedValue(null);

    const next = await run();

    expect(next.mock.calls[0][0].statusCode).toBe(503);
    expect(next.mock.calls[0][0].message).toContain('unavailable');
  });

  test('passes an unexpected fault on unchanged rather than disguising it', async () => {
    // An UnauthorizedError is deliberately never logged; mislabelling a real
    // fault as one would hide it from error reporting entirely.
    EndpointAuthorize.authorize.mockRejectedValue(new Error('socket hang up'));

    const next = await run();

    expect(next.mock.calls[0][0]).not.toBeInstanceOf(UnauthorizedError);
    expect(next.mock.calls[0][0].message).toBe('socket hang up');
  });
});
