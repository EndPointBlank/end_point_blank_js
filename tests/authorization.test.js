'use strict';

const { instance: config } = require('../src/configuration');
const { Authorization } = require('../src/authorization');

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
