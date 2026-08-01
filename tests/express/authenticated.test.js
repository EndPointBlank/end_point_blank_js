'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { UnauthorizedError } = require('../../src/unauthorized-error');
const { authenticated } = require('../../src/express/authenticated');

/**
 * Driven through the middleware with only the network faked, so the path and
 * version the SDK reports are the ones a real Express request would produce.
 */
describe('authenticated middleware', () => {
  const okResponse = { status: 201, ok: true };

  const run = async req => {
    const next = jest.fn();
    await authenticated(req, {}, next);
    return next;
  };

  const bodySent = () => post.mock.calls[0][2];

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    post.mockReset();
    post.mockResolvedValue(okResponse);
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  describe('an authenticated caller', () => {
    test('is allowed through', async () => {
      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('what it asks about', () => {
    test('reports the route pattern rather than the concrete URL', async () => {
      // `/students/42` and `/students/43` are the same endpoint. Sending the
      // concrete URL would make every id its own endpoint in the portal.
      await run({
        headers: {},
        method: 'GET',
        route: { path: '/students/:id' },
        path: '/students/42',
      });

      expect(bodySent().path).toBe('/students/:id');
    });

    test('falls back to the request path when no route matched', async () => {
      await run({ headers: {}, method: 'GET', path: '/students' });

      expect(bodySent().path).toBe('/students');
    });

    test('falls back to the raw URL for a bare Node request', async () => {
      await run({ headers: {}, method: 'GET', url: '/students' });

      expect(bodySent().path).toBe('/students');
    });

    test('reports the detected endpoint version', async () => {
      await run({ headers: { 'x-api-version': 'v2' }, method: 'GET', path: '/students' });

      expect(bodySent().version).toBe('2');
    });
  });

  describe('a caller who is refused', () => {
    test('is stopped with an UnauthorizedError rather than reaching the route', async () => {
      post.mockResolvedValue({
        status: 401,
        json: async () => ({ error: 'unknown client' }),
        text: async () => 'unknown client',
      });

      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    });

    test('is told why, using the reason the service gave', async () => {
      post.mockResolvedValue({
        status: 401,
        json: async () => ({ error: 'unknown client' }),
        text: async () => 'unknown client',
      });

      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next.mock.calls[0][0].message).toContain('unknown client');
    });

    test('falls back to the raw response text when the service did not send JSON', async () => {
      // A proxy in front of the service answers with HTML; the operator still
      // needs to see what came back.
      post.mockResolvedValue({
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
        text: async () => 'Bad Gateway',
      });

      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next.mock.calls[0][0].message).toContain('Bad Gateway');
    });

    test('still explains itself when the response body cannot be read at all', async () => {
      post.mockResolvedValue({
        status: 500,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
        text: async () => {
          throw new TypeError('terminated');
        },
      });

      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
      expect(next.mock.calls[0][0].message).toBeTruthy();
    });

    test('treats an unexpected success status as a refusal', async () => {
      // Only 201 means authenticated. A 200 from a misrouted proxy must not
      // be read as approval.
      post.mockResolvedValue({ status: 200, json: async () => ({}), text: async () => '' });

      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    });
  });

  describe('when the service cannot be reached', () => {
    test('refuses the request rather than letting it through', async () => {
      // Failing open would turn an EndPointBlank outage into an authentication
      // bypass on the customer's API.
      post.mockResolvedValue(null);

      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
      expect(next.mock.calls[0][0].message).toContain('unavailable');
    });
  });

  describe('when something unexpected goes wrong', () => {
    test('passes the original error on rather than disguising it as a refusal', async () => {
      // An UnauthorizedError is deliberately not logged. Mislabelling a real
      // fault as one would hide it from error reporting entirely.
      post.mockRejectedValue(new Error('socket hang up'));

      const next = await run({ headers: {}, method: 'GET', path: '/students' });

      expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(next.mock.calls[0][0]).not.toBeInstanceOf(UnauthorizedError);
      expect(next.mock.calls[0][0].message).toBe('socket hang up');
    });
  });
});
