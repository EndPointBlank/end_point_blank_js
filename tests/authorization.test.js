'use strict';

jest.mock('../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../src/commands/_http');
const { instance: config } = require('../src/configuration');
const { Authorization } = require('../src/authorization');
const { AccessTokens } = require('../src/tokens/access-tokens');

beforeEach(() => {
  config._reset();
  config.clientId = 'test-client-id';
  config.clientSecret = 'test-client-secret';
});
afterEach(() => config._reset());

test('basicCredentials returns base64-encoded clientId:clientSecret', () => {
  const creds = Authorization.basicCredentials();
  const decoded = Buffer.from(creds, 'base64').toString();
  expect(decoded).toBe('test-client-id:test-client-secret');
});

test('header() with no hostname returns Basic auth', async () => {
  const header = await Authorization.header();
  expect(header).toMatch(/^Basic /);
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  expect(decoded).toBe('test-client-id:test-client-secret');
});

test('header() with null hostname returns Basic auth', async () => {
  const header = await Authorization.header(null);
  expect(header).toMatch(/^Basic /);
});

// Basic credentials go over the wire on every call; a per-host Bearer token is
// the credential the SDK is meant to spend once it has one. Only the network is
// faked here, so the real token cache decides which header comes back.
describe('header() for a known hostname', () => {
  const tokenResponse = token => ({
    status: 201,
    ok: true,
    json: async () => ({ token, expired_at: new Date(Date.now() + 3600 * 1000).toISOString() }),
  });

  beforeEach(() => {
    AccessTokens.clear();
    post.mockReset();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    AccessTokens.clear();
  });

  test('returns a Bearer token once one can be obtained', async () => {
    post.mockResolvedValue(tokenResponse('tok-1'));

    await expect(Authorization.header('api.example.test')).resolves.toBe('Bearer tok-1');
  });

  test('falls back to Basic when no token can be obtained', async () => {
    // Losing the token service must degrade to credentials that still work,
    // not to an unauthenticated call the portal will reject.
    post.mockResolvedValue(null);

    await expect(Authorization.header('api.example.test')).resolves.toMatch(/^Basic /);
  });
});
