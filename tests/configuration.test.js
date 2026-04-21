'use strict';

const epb = require('../src/index');
const { instance: config, LogMode } = require('../src/configuration');

beforeEach(() => config._reset());
afterEach(() => config._reset());

test('configure sets clientId and clientSecret', () => {
  epb.configure({ clientId: 'my-id', clientSecret: 'my-secret' });
  expect(config.clientId).toBe('my-id');
  expect(config.clientSecret).toBe('my-secret');
});

test('configure sets appName and environment', () => {
  epb.configure({ appName: 'test-app', environment: 'staging' });
  expect(config.appName).toBe('test-app');
  expect(config.environment).toBe('staging');
});

test('configure ignores undefined values', () => {
  config.clientId = 'original';
  epb.configure({ clientSecret: 'new-secret' });
  expect(config.clientId).toBe('original');
  expect(config.clientSecret).toBe('new-secret');
});

test('configure sets logMode', () => {
  epb.configure({ logMode: LogMode.DELAYED });
  expect(config.logMode).toBe(LogMode.DELAYED);
});

test('default baseUrl', () => {
  expect(config.baseUrl).toBe('https://endpointblank.com/api');
});

test('default workerCount', () => {
  expect(config.workerCount).toBe(4);
});

test('default logMode is DIRECT', () => {
  expect(config.logMode).toBe(LogMode.DIRECT);
});

test('default cacheTtl is 300', () => {
  expect(config.cacheTtl).toBe(300);
});

test('url getters build from baseUrl', () => {
  config.baseUrl = 'https://example.com/api';
  expect(config.logUrl).toBe('https://example.com/api/api/logs');
  expect(config.accessTokenUrl).toBe('https://example.com/api/api/access_token');
  expect(config.authorizeUrl).toBe('https://example.com/api/api/authorize');
  expect(config.endpointUpdateUrl).toBe('https://example.com/api/api/application_updates');
  expect(config.applicationErrorsUrl).toBe('https://example.com/api/api/application_errors');
  expect(config.endpointErrorUrl).toBe('https://example.com/api/api/endpoint_errors');
});
