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

test('default base urls', () => {
  expect(config.baseUrl).toBe('https://in.endpointblank.com');
  expect(config.logBaseUrl).toBe('https://log.endpointblank.com');
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

test('control-plane url getters build from baseUrl', () => {
  config.baseUrl = 'https://example.com';
  expect(config.accessTokenUrl).toBe('https://example.com/api/access_token');
  expect(config.authorizeUrl).toBe('https://example.com/api/authorize');
  expect(config.endpointUpdateUrl).toBe('https://example.com/api/application_updates');
  expect(config.endpointErrorUrl).toBe('https://example.com/api/endpoint_errors');
});

test('log/ingest url getters build from logBaseUrl', () => {
  config.logBaseUrl = 'https://logs.example.com';
  expect(config.logUrl).toBe('https://logs.example.com/api/application_logs');
  expect(config.applicationErrorsUrl).toBe('https://logs.example.com/api/application_errors');
  expect(config.requestsUrl).toBe('https://logs.example.com/api/application_requests');
  expect(config.responsesUrl).toBe('https://logs.example.com/api/application_responses');
});
