'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { BasicAuthenticate } = require('../../src/commands/basic-authenticate');

describe('BasicAuthenticate.authenticate', () => {
  const req = (overrides = {}) => ({
    headers: { authorization: 'Basic Y2xpZW50', ...overrides.headers },
    method: 'POST',
    originalUrl: '/api/v1/students',
    ...overrides,
  });

  const okResponse = { status: 201, ok: true };

  const bodySent = () => post.mock.calls[0][2];

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.baseUrl = 'https://epb.test';
    post.mockReset();
    post.mockResolvedValue(okResponse);
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  describe('the request it sends', () => {
    test('goes to the authorize endpoint', async () => {
      await BasicAuthenticate.authenticate(req(), '/students', '1');

      expect(post.mock.calls[0][0]).toBe('https://epb.test/api/authorize');
    });

    test('describes the call being authenticated', async () => {
      await BasicAuthenticate.authenticate(req(), '/students', '1');

      expect(bodySent()).toMatchObject({
        path: '/students',
        action: 'POST',
        client_auth: 'Basic Y2xpZW50',
        application: 'billing',
        version: '1',
      });
    });

    test('always presents the SDK\'s own client credentials', async () => {
      // Authentication asks the portal about the *caller's* credentials, so
      // the SDK identifies itself with its own rather than a per-host token.
      await BasicAuthenticate.authenticate(req(), '/students', '1');

      expect(post.mock.calls[0][1]).toMatch(/^Basic /);
    });
  });

  describe('the client IP it reports', () => {
    test('prefers an explicitly supplied address', async () => {
      await BasicAuthenticate.authenticate(req({ ip: '192.0.2.9' }), '/students', '1', '203.0.113.1');

      expect(bodySent().ip_address).toBe('203.0.113.1');
    });

    test('is the original client when the request came through a proxy', async () => {
      await BasicAuthenticate.authenticate(
        req({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }),
        '/students',
        '1',
      );

      expect(bodySent().ip_address).toBe('203.0.113.7');
    });

    test('is the socket address when there is no proxy header', async () => {
      await BasicAuthenticate.authenticate(
        req({ socket: { remoteAddress: '198.51.100.4' } }),
        '/students',
        '1',
      );

      expect(bodySent().ip_address).toBe('198.51.100.4');
    });

    test('falls back to the framework-resolved IP', async () => {
      await BasicAuthenticate.authenticate(req({ ip: '192.0.2.9' }), '/students', '1');

      expect(bodySent().ip_address).toBe('192.0.2.9');
    });

    test('is null when nothing identifies the caller', async () => {
      await BasicAuthenticate.authenticate(req(), '/students', '1');

      expect(bodySent().ip_address).toBeNull();
    });
  });

  describe('the answer it returns', () => {
    test('hands back the service response on success', async () => {
      await expect(BasicAuthenticate.authenticate(req(), '/students', '1')).resolves.toBe(okResponse);
    });

    test('hands back a refusal unchanged rather than deciding for the caller', async () => {
      const refusal = { status: 401, ok: false, text: async () => 'bad credentials' };
      post.mockResolvedValue(refusal);

      await expect(BasicAuthenticate.authenticate(req(), '/students', '1')).resolves.toBe(refusal);
    });

    test('returns null when the service is unreachable', async () => {
      post.mockResolvedValue(null);

      await expect(BasicAuthenticate.authenticate(req(), '/students', '1')).resolves.toBeNull();
    });

    test('survives a refusal whose body cannot be read', async () => {
      // This runs inside the customer's request. A drained or terminated body
      // must not turn a 500 from the service into a 500 from their app.
      const refusal = {
        status: 500,
        ok: false,
        text: async () => {
          throw new TypeError('terminated');
        },
      };
      post.mockResolvedValue(refusal);

      await expect(BasicAuthenticate.authenticate(req(), '/students', '1')).resolves.toBe(refusal);
    });
  });

  test('works for a bare Node request that has no originalUrl', async () => {
    const bare = { headers: {}, method: 'GET', url: '/students' };

    await expect(BasicAuthenticate.authenticate(bare, '/students', null)).resolves.toBe(okResponse);
  });

  test('works for a request with no headers at all', async () => {
    await expect(BasicAuthenticate.authenticate({ method: 'GET' }, '/students', null)).resolves.toBe(
      okResponse,
    );
  });
});
