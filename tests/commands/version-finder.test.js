'use strict';

const { VersionFinder } = require('../../src/commands/version-finder');
const { instance: config } = require('../../src/configuration');

beforeEach(() => config._reset());
afterEach(() => config._reset());

function makeReq(overrides = {}) {
  return {
    headers: {},
    url: '/',
    path: '/',
    originalUrl: '/',
    ...overrides,
  };
}

test('finds version from Accept header', () => {
  const req = makeReq({ headers: { accept: 'application/vnd.api.v2+json' } });
  expect(VersionFinder.find(req)).toBe('2');
});

test('finds version from X-Api-Version header', () => {
  const req = makeReq({ headers: { 'x-api-version': 'v3' } });
  expect(VersionFinder.find(req)).toBe('3');
});

test('finds version from Content-Type header', () => {
  const req = makeReq({ headers: { 'content-type': 'application/vnd.myapp.v1+json' } });
  expect(VersionFinder.find(req)).toBe('1');
});

test('finds version from query parameter', () => {
  const req = makeReq({ url: '/users?version=v5', originalUrl: '/users?version=v5' });
  expect(VersionFinder.find(req)).toBe('5');
});

test('finds version from URL path segment', () => {
  const req = makeReq({ path: '/api/v4/users', url: '/api/v4/users', originalUrl: '/api/v4/users' });
  expect(VersionFinder.find(req)).toBe('4');
});

test('returns null when no version found', () => {
  const req = makeReq({ headers: { accept: 'application/json' }, path: '/users', url: '/users', originalUrl: '/users' });
  expect(VersionFinder.find(req)).toBeNull();
});

test('Accept header takes precedence over path', () => {
  const req = makeReq({
    headers: { accept: 'application/vnd.api.v2+json' },
    path: '/api/v1/users',
    url: '/api/v1/users',
    originalUrl: '/api/v1/users',
  });
  expect(VersionFinder.find(req)).toBe('2');
});

test('custom versionFinder takes precedence', () => {
  config.versionFinder = () => '42';
  const req = makeReq({ path: '/api/v1/users' });
  expect(VersionFinder.find(req)).toBe('42');
});

test('query param without leading v prefix still works', () => {
  const req = makeReq({ url: '/users?version=v7&other=true', originalUrl: '/users?version=v7&other=true' });
  expect(VersionFinder.find(req)).toBe('7');
});
