'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { GenerateAccessToken } = require('../../src/commands/generate-access-token');

describe('GenerateAccessToken.token', () => {
  const okResponse = body => ({ status: 201, ok: true, json: async () => body });

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.baseUrl = 'https://epb.test';
    post.mockReset();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  test('asks the access token endpoint for the given hostname', async () => {
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token('api.example.test');

    const [url, , body] = post.mock.calls[0];
    expect(url).toBe('https://epb.test/api/access_token');
    expect(body).toEqual({ hostname: 'api.example.test' });
  });

  test('presents the configured client credentials', async () => {
    // A token request is the one call that cannot itself use a token, so it
    // must go out as Basic or the SDK can never bootstrap.
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token('api.example.test');

    const authHeader = post.mock.calls[0][1];
    expect(Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString()).toBe(
      'client-id:client-secret',
    );
  });

  test('asks for the configured token lifetime when one is set', async () => {
    config.tokenTtl = 900;
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token('api.example.test');

    expect(post.mock.calls[0][2]).toEqual({ hostname: 'api.example.test', token_ttl: 900 });
  });

  test('omits the lifetime entirely when none is configured, letting the service decide', async () => {
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token('api.example.test');

    expect(post.mock.calls[0][2]).not.toHaveProperty('token_ttl');
  });

  test('asks for a zero lifetime when that is what was configured', async () => {
    // `0` is falsy but meaningful; a truthiness check here would silently drop it.
    config.tokenTtl = 0;
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token('api.example.test');

    expect(post.mock.calls[0][2].token_ttl).toBe(0);
  });

  test('returns the payload the service sent back', async () => {
    post.mockResolvedValue(okResponse({ token: 'tok-1', expired_at: '2026-01-01T00:00:00Z' }));

    await expect(GenerateAccessToken.token('api.example.test')).resolves.toEqual({
      token: 'tok-1',
      expired_at: '2026-01-01T00:00:00Z',
    });
  });

  test('returns an error payload rather than inventing a token', async () => {
    post.mockResolvedValue({ status: 422, ok: false, json: async () => ({ error: 'no such app' }) });

    await expect(GenerateAccessToken.token('api.example.test')).resolves.toEqual({
      error: 'no such app',
    });
  });

  test('returns null when the service is unreachable', async () => {
    post.mockResolvedValue(null);

    await expect(GenerateAccessToken.token('api.example.test')).resolves.toBeNull();
  });

  test('returns null rather than throwing when the response is not JSON', async () => {
    // An HTML error page from a proxy must not take the caller's request down
    // with it — this runs inside the customer's request path.
    post.mockResolvedValue({
      status: 502,
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(GenerateAccessToken.token('api.example.test')).resolves.toBeNull();
  });
});
