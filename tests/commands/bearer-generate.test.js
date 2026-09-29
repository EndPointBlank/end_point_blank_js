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

describe('deprecation (sc-1469)', () => {
  const {
    _resetDeprecationWarning,
    DEPRECATION_MESSAGE,
  } = require('../../src/commands/bearer-generate');

  beforeEach(() => _resetDeprecationWarning());
  afterEach(() => jest.restoreAllMocks());

  test('emits one DeprecationWarning, on the first call only', () => {
    const emit = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});

    BearerGenerate.authHeader();
    BearerGenerate.generate();
    BearerGenerate.authHeader();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(DEPRECATION_MESSAGE, 'DeprecationWarning');
    expect(DEPRECATION_MESSAGE).toMatch(/never send it to a provider/i);
    expect(DEPRECATION_MESSAGE).toMatch(/Authorization\.header\(url\)/);
  });

  test('generate() alone also triggers it', () => {
    const emit = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});

    BearerGenerate.generate();
    BearerGenerate.generate();

    expect(emit).toHaveBeenCalledTimes(1);
  });
});
