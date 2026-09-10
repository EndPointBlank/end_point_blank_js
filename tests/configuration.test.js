'use strict';

const epb = require('../src/index');
const { instance: config, LogMode, ConfigurationError } = require('../src/configuration');

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

test('configure sets maskingRules and maskHook', () => {
  const rules = [{ target: 'request_body', path: '$..ssn', replacement_value: '***' }];
  const hook = (payload) => payload;
  epb.configure({ maskingRules: rules, maskHook: hook });
  expect(config.maskingRules).toBe(rules);
  expect(config.maskHook).toBe(hook);
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
});

test('log/ingest url getters build from logBaseUrl', () => {
  config.logBaseUrl = 'https://logs.example.com';
  expect(config.logUrl).toBe('https://logs.example.com/api/application_logs');
  expect(config.applicationErrorsUrl).toBe('https://logs.example.com/api/application_errors');
  expect(config.requestsUrl).toBe('https://logs.example.com/api/application_requests');
  expect(config.responsesUrl).toBe('https://logs.example.com/api/application_responses');
});

describe('base URL normalization', () => {
  describe('trailing slashes are stripped', () => {
    test('a single trailing slash on baseUrl is stripped and builds a correct URL', () => {
      config.baseUrl = 'https://example.com/';
      expect(config.baseUrl).toBe('https://example.com');
      expect(config.authorizeUrl).toBe('https://example.com/api/authorize');
      expect(config.accessTokenUrl).toBe('https://example.com/api/access_token');
    });

    test('multiple trailing slashes on baseUrl are stripped and build a correct URL', () => {
      config.baseUrl = 'https://example.com///';
      expect(config.baseUrl).toBe('https://example.com');
      expect(config.authorizeUrl).toBe('https://example.com/api/authorize');
    });

    test('a single trailing slash on logBaseUrl is stripped and builds a correct URL', () => {
      config.logBaseUrl = 'https://logs.example.com/';
      expect(config.logBaseUrl).toBe('https://logs.example.com');
      expect(config.logUrl).toBe('https://logs.example.com/api/application_logs');
    });

    test('multiple trailing slashes on logBaseUrl are stripped and build a correct URL', () => {
      config.logBaseUrl = 'https://logs.example.com////';
      expect(config.logBaseUrl).toBe('https://logs.example.com');
      expect(config.logUrl).toBe('https://logs.example.com/api/application_logs');
    });
  });

  describe('an /api-suffixed base URL raises', () => {
    test('baseUrl raises a ConfigurationError with an actionable message', () => {
      config.baseUrl = 'https://example.com/api';
      expect(() => config.baseUrl).toThrow(ConfigurationError);
      expect(() => config.baseUrl).toThrow(
        "baseUrl 'https://example.com/api' already ends in '/api'"
      );
      expect(() => config.baseUrl).toThrow(/Set baseUrl to the origin only/);
    });

    test('baseUrl still raises once a trailing slash is stripped down to /api', () => {
      config.baseUrl = 'https://example.com/api/';
      expect(() => config.baseUrl).toThrow(ConfigurationError);
    });

    test('building a URL from an /api-suffixed baseUrl raises rather than doubling up', () => {
      config.baseUrl = 'https://example.com/api';
      expect(() => config.authorizeUrl).toThrow(ConfigurationError);
      expect(() => config.accessTokenUrl).toThrow(ConfigurationError);
    });

    test('logBaseUrl raises a ConfigurationError with an actionable message', () => {
      config.logBaseUrl = 'https://logs.example.com/api';
      expect(() => config.logBaseUrl).toThrow(ConfigurationError);
      expect(() => config.logBaseUrl).toThrow(
        "logBaseUrl 'https://logs.example.com/api' already ends in '/api'"
      );
      expect(() => config.logBaseUrl).toThrow(/Set logBaseUrl to the origin only/);
    });

    test('logBaseUrl still raises once a trailing slash is stripped down to /api', () => {
      config.logBaseUrl = 'https://logs.example.com/api/';
      expect(() => config.logBaseUrl).toThrow(ConfigurationError);
    });

    test('building a URL from an /api-suffixed logBaseUrl raises rather than doubling up', () => {
      config.logBaseUrl = 'https://logs.example.com/api';
      expect(() => config.logUrl).toThrow(ConfigurationError);
      expect(() => config.requestsUrl).toThrow(ConfigurationError);
    });

    test('is catchable via the package root, not only src/configuration', () => {
      // The whole point of a named error class is that a caller can catch
      // it specifically. `epb.ConfigurationError` has to be the exact class
      // thrown here, not a same-named lookalike, or `catch (e) { if (e
      // instanceof epb.ConfigurationError) ... }` would silently never match.
      config.baseUrl = 'https://example.com/api';
      expect(() => config.baseUrl).toThrow(epb.ConfigurationError);
      expect(epb.ConfigurationError).toBe(ConfigurationError);
    });

    test('baseUrl and logBaseUrl are checked independently -- one being bad does not affect the other', () => {
      config.baseUrl = 'https://example.com/api';
      config.logBaseUrl = 'https://logs.example.com';
      expect(() => config.logBaseUrl).not.toThrow();
      expect(config.logUrl).toBe('https://logs.example.com/api/application_logs');
    });
  });

  describe('a clean base URL is unaffected', () => {
    test('baseUrl with no trailing slash and no /api suffix passes through and builds correctly', () => {
      config.baseUrl = 'https://example.com';
      expect(() => config.baseUrl).not.toThrow();
      expect(config.baseUrl).toBe('https://example.com');
      expect(config.authorizeUrl).toBe('https://example.com/api/authorize');
      expect(config.accessTokenUrl).toBe('https://example.com/api/access_token');
    });

    test('logBaseUrl with no trailing slash and no /api suffix passes through and builds correctly', () => {
      config.logBaseUrl = 'https://logs.example.com';
      expect(() => config.logBaseUrl).not.toThrow();
      expect(config.logBaseUrl).toBe('https://logs.example.com');
      expect(config.logUrl).toBe('https://logs.example.com/api/application_logs');
    });

    test('a host that merely contains "api" is not mistaken for the /api suffix', () => {
      config.baseUrl = 'https://api.example.com';
      expect(() => config.baseUrl).not.toThrow();
      expect(config.baseUrl).toBe('https://api.example.com');
    });
  });
});

describe('ENDPOINTBLANK_* environment variable configuration', () => {
  const ENV_KEYS = [
    'ENDPOINTBLANK_CLIENT_ID',
    'ENDPOINTBLANK_CLIENT_SECRET',
    'ENDPOINTBLANK_BASE_URL',
    'ENDPOINTBLANK_LOG_BASE_URL',
    'ENDPOINTBLANK_APP_NAME',
    'ENDPOINTBLANK_ENV',
  ];
  const savedEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('clientId / ENDPOINTBLANK_CLIENT_ID', () => {
    test('falls back to env var when unset', () => {
      process.env.ENDPOINTBLANK_CLIENT_ID = 'env-client-id';
      expect(config.clientId).toBe('env-client-id');
    });

    test('explicit configure value beats env var', () => {
      process.env.ENDPOINTBLANK_CLIENT_ID = 'env-client-id';
      epb.configure({ clientId: 'explicit-client-id' });
      expect(config.clientId).toBe('explicit-client-id');
    });

    test('env var beats built-in default (null)', () => {
      process.env.ENDPOINTBLANK_CLIENT_ID = 'env-client-id';
      expect(config.clientId).not.toBeNull();
      expect(config.clientId).toBe('env-client-id');
    });

    test('defaults to null when neither set', () => {
      expect(config.clientId).toBeNull();
    });
  });

  describe('clientSecret / ENDPOINTBLANK_CLIENT_SECRET', () => {
    test('falls back to env var when unset', () => {
      process.env.ENDPOINTBLANK_CLIENT_SECRET = 'env-client-secret';
      expect(config.clientSecret).toBe('env-client-secret');
    });

    test('explicit configure value beats env var', () => {
      process.env.ENDPOINTBLANK_CLIENT_SECRET = 'env-client-secret';
      epb.configure({ clientSecret: 'explicit-client-secret' });
      expect(config.clientSecret).toBe('explicit-client-secret');
    });

    test('env var beats built-in default (null)', () => {
      process.env.ENDPOINTBLANK_CLIENT_SECRET = 'env-client-secret';
      expect(config.clientSecret).not.toBeNull();
      expect(config.clientSecret).toBe('env-client-secret');
    });

    test('defaults to null when neither set', () => {
      expect(config.clientSecret).toBeNull();
    });
  });

  describe('baseUrl / ENDPOINTBLANK_BASE_URL', () => {
    test('falls back to env var when unset', () => {
      process.env.ENDPOINTBLANK_BASE_URL = 'https://env.example.com';
      expect(config.baseUrl).toBe('https://env.example.com');
    });

    test('explicit configure value beats env var', () => {
      process.env.ENDPOINTBLANK_BASE_URL = 'https://env.example.com';
      epb.configure({ baseUrl: 'https://explicit.example.com' });
      expect(config.baseUrl).toBe('https://explicit.example.com');
    });

    test('env var beats built-in default', () => {
      process.env.ENDPOINTBLANK_BASE_URL = 'https://env.example.com';
      expect(config.baseUrl).not.toBe('https://in.endpointblank.com');
      expect(config.baseUrl).toBe('https://env.example.com');
    });

    test('defaults to built-in URL when neither set', () => {
      expect(config.baseUrl).toBe('https://in.endpointblank.com');
    });
  });

  describe('logBaseUrl / ENDPOINTBLANK_LOG_BASE_URL', () => {
    test('falls back to env var when unset', () => {
      process.env.ENDPOINTBLANK_LOG_BASE_URL = 'https://env-log.example.com';
      expect(config.logBaseUrl).toBe('https://env-log.example.com');
    });

    test('explicit configure value beats env var', () => {
      process.env.ENDPOINTBLANK_LOG_BASE_URL = 'https://env-log.example.com';
      epb.configure({ logBaseUrl: 'https://explicit-log.example.com' });
      expect(config.logBaseUrl).toBe('https://explicit-log.example.com');
    });

    test('env var beats built-in default', () => {
      process.env.ENDPOINTBLANK_LOG_BASE_URL = 'https://env-log.example.com';
      expect(config.logBaseUrl).not.toBe('https://log.endpointblank.com');
      expect(config.logBaseUrl).toBe('https://env-log.example.com');
    });

    test('defaults to built-in URL when neither set', () => {
      expect(config.logBaseUrl).toBe('https://log.endpointblank.com');
    });
  });

  describe('appName / ENDPOINTBLANK_APP_NAME', () => {
    test('falls back to env var when unset', () => {
      process.env.ENDPOINTBLANK_APP_NAME = 'env-app';
      expect(config.appName).toBe('env-app');
    });

    test('explicit configure value beats env var', () => {
      process.env.ENDPOINTBLANK_APP_NAME = 'env-app';
      epb.configure({ appName: 'explicit-app' });
      expect(config.appName).toBe('explicit-app');
    });

    test('env var beats built-in default (null)', () => {
      process.env.ENDPOINTBLANK_APP_NAME = 'env-app';
      expect(config.appName).not.toBeNull();
      expect(config.appName).toBe('env-app');
    });

    test('defaults to null when neither set', () => {
      expect(config.appName).toBeNull();
    });
  });

  describe('environment / ENDPOINTBLANK_ENV', () => {
    test('falls back to env var when unset', () => {
      process.env.ENDPOINTBLANK_ENV = 'env-staging';
      expect(config.environment).toBe('env-staging');
    });

    test('explicit configure value beats env var', () => {
      process.env.ENDPOINTBLANK_ENV = 'env-staging';
      epb.configure({ environment: 'explicit-production' });
      expect(config.environment).toBe('explicit-production');
    });

    test('env var beats built-in default (null)', () => {
      process.env.ENDPOINTBLANK_ENV = 'env-staging';
      expect(config.environment).not.toBeNull();
      expect(config.environment).toBe('env-staging');
    });

    test('defaults to null when neither set', () => {
      expect(config.environment).toBeNull();
    });
  });
});
