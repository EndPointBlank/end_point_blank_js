'use strict';

const { BearerGenerate } = require('../../src/commands/bearer-generate');
const { instance: config } = require('../../src/configuration');

beforeEach(() => {
  config._reset();
  config.clientId = 'test-id';
  config.clientSecret = 'test-secret';
});
afterEach(() => config._reset());

test('generate returns base64-encoded clientId:clientSecret', () => {
  const generated = BearerGenerate.generate();
  const decoded = Buffer.from(generated, 'base64').toString();
  expect(decoded).toBe('test-id:test-secret');
});

test('authHeader starts with "Basic "', () => {
  expect(BearerGenerate.authHeader()).toMatch(/^Basic /);
});

test('authHeader contains correctly encoded credentials', () => {
  const header = BearerGenerate.authHeader();
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  expect(decoded).toBe('test-id:test-secret');
});
