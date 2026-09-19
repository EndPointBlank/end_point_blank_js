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

describe('configure refuses unknown keys', () => {
  // Written out here rather than imported from src, so a key silently dropped
  // from the implementation's list fails these tests instead of agreeing with it.
  const VALID_KEYS = [
    'clientId', 'clientSecret', 'baseUrl', 'logBaseUrl', 'environment', 'appName',
    'workerCount', 'logMode', 'versionFinder', 'applicationVersion',
    'tokenTtl', 'cacheTtl', 'trustProxyHeaders', 'maskingRules', 'maskHook',
  ];

  const thrownBy = (fn) => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error('expected configure to throw, but it returned');
  };

  test('a misspelled key throws a ConfigurationError naming it', () => {
    const err = thrownBy(() => epb.configure({ clientSecert: 'my-secret' }));
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err).toBeInstanceOf(epb.ConfigurationError);
    expect(err.message).toContain('clientSecert');
  });

  test('the message lists every valid key', () => {
    const err = thrownBy(() => epb.configure({ baseUri: 'https://staging.example.com' }));
    for (const key of VALID_KEYS) {
      expect(err.message).toContain(key);
    }
  });

  test('every unknown key is named, not just the first', () => {
    const err = thrownBy(() => epb.configure({ baseUri: 'x', clientSecert: 'y', appname: 'z' }));
    expect(err.message).toContain('baseUri');
    expect(err.message).toContain('clientSecert');
    expect(err.message).toContain('appname');
  });

  test('nothing is applied when any key is unknown', () => {
    expect(() => epb.configure({
      clientId: 'my-id',
      baseUrl: 'https://staging.example.com',
      clientSecert: 'my-secret',
    })).toThrow(ConfigurationError);
    expect(config.clientId).toBeNull();
    expect(config.baseUrl).toBe('https://in.endpointblank.com');
  });

  test('an unknown key throws even when its value is undefined', () => {
    // `{ clientSecert: process.env.EPB_SECRET }` is still a typo when the
    // variable happens to be unset.
    expect(() => epb.configure({ clientSecert: undefined })).toThrow(ConfigurationError);
  });

  test('every valid key is accepted', () => {
    // `null` for everything except `cacheTtl`, which refuses an explicit
    // `null` by design (sc-970 -- see the cacheTtl contract below).
    const opts = { ...Object.fromEntries(VALID_KEYS.map((key) => [key, null])), cacheTtl: 300 };
    expect(() => epb.configure(opts)).not.toThrow();
  });
});

// sc-970: the one `cache_ttl` rule decided for the JS, Java, Elixir, Python
// and Rails SDKs. Omitted means the 300s default; `0` means the cache is
// disabled; an explicit `null`, a negative number, or anything that is not an
// integer is refused with a ConfigurationError at configure time -- not
// silently defaulted, and not left to misbehave at first cache use.
describe('sc-970: the cacheTtl contract', () => {
  const { instance: cache } = require('../src/commands/authentication-cache');

  beforeEach(() => cache.clear());
  afterEach(() => cache.clear());

  const thrownBy = (fn) => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error('expected a throw, but none happened');
  };

  describe('omitted', () => {
    test('configure() without cacheTtl leaves the 300s default', () => {
      epb.configure({ clientId: 'my-id' });
      expect(config.cacheTtl).toBe(300);
    });

    test('an explicitly undefined cacheTtl is treated as omitted, like every other configure() key', () => {
      // `{ cacheTtl: process.env.EPB_CACHE_TTL }` with the variable unset.
      expect(() => epb.configure({ cacheTtl: undefined })).not.toThrow();
      expect(config.cacheTtl).toBe(300);
    });

    test('the default actually caches for 300s', () => {
      jest.useFakeTimers();
      try {
        epb.configure({});
        cache.store('key', 'credentials');

        jest.advanceTimersByTime(299_000);
        expect(cache.retrieve('key')).toBe('credentials');

        jest.advanceTimersByTime(2_000);
        expect(cache.retrieve('key')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('explicit null', () => {
    test('configure() throws a ConfigurationError naming cacheTtl and telling you to omit it for the default', () => {
      const err = thrownBy(() => epb.configure({ cacheTtl: null }));
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err).toBeInstanceOf(epb.ConfigurationError);
      expect(err.message).toContain('cacheTtl');
      expect(err.message).toContain('null');
      expect(err.message).toMatch(/omit/i);
      expect(err.message).toContain('300');
    });

    test('direct assignment on the exported config object throws too, and keeps the previous value', () => {
      // `epb.config` is public; it must not be a way around the rule.
      expect(() => { epb.config.cacheTtl = null; }).toThrow(ConfigurationError);
      expect(config.cacheTtl).toBe(300);
    });
  });

  describe('direct assignment of undefined', () => {
    // configure() skips an undefined key (see 'omitted' above), but assigning
    // `undefined` to the property is an explicit write of a non-value. The
    // cache reads `config.cacheTtl` with no fallback, so a stored `undefined`
    // would give every entry a NaN expiry: written, counted, never a hit.
    test('throws and keeps the previous value', () => {
      const err = thrownBy(() => { epb.config.cacheTtl = undefined; });
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.message).toContain('cacheTtl');
      expect(err.message).toContain('undefined');
      expect(config.cacheTtl).toBe(300);
    });

    test('leaves the cache working at the previous ttl', () => {
      expect(() => { epb.config.cacheTtl = undefined; }).toThrow(ConfigurationError);

      cache.store('key', 'credentials');
      expect(cache.retrieve('key')).toBe('credentials');
    });
  });

  describe('0 disables the cache (unchanged)', () => {
    test('is accepted', () => {
      expect(() => epb.configure({ cacheTtl: 0 })).not.toThrow();
      expect(config.cacheTtl).toBe(0);
    });

    test('means nothing is cached', () => {
      epb.configure({ cacheTtl: 0 });
      cache.store('key', 'credentials');

      expect(cache.size()).toBe(0);
      expect(cache.retrieve('key')).toBeNull();
    });

    test('-0 is 0, not a negative number: accepted, and disables the cache', () => {
      // A deliberate decision: `Number.isInteger(-0)` is true and `-0 < 0` is
      // false. (The other four SDKs have no integer -0 to decide about.)
      expect(() => epb.configure({ cacheTtl: -0 })).not.toThrow();
      cache.store('key', 'credentials');

      expect(cache.size()).toBe(0);
      expect(cache.retrieve('key')).toBeNull();
    });
  });

  describe('a positive integer', () => {
    test('is accepted as-is', () => {
      epb.configure({ cacheTtl: 60 });
      expect(config.cacheTtl).toBe(60);
    });
  });

  describe('invalid values throw at configure time', () => {
    test('a negative number throws, rather than silently disabling the cache as it used to', () => {
      const err = thrownBy(() => epb.configure({ cacheTtl: -5 }));
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.message).toContain('cacheTtl');
      expect(err.message).toContain('-5');
    });

    // A string is quoted in the message, so '"300"' is distinguishable from
    // the "default of 300 seconds" the message also mentions.
    test.each([
      ['a non-numeric string', 'abc', '"abc"'],
      ['a numeric string', '300', '"300"'],
      ['a float', 3.5, '3.5'],
      ['NaN', NaN, 'NaN'],
      ['Infinity', Infinity, 'Infinity'],
      ['a boolean', true, 'true'],
      ['an array', [300], 'a value of type array'],
      // Neither of these can be turned into a string with `${value}`. The
      // message must still be built, or the caller gets a TypeError from
      // inside the error path instead of the ConfigurationError.
      ['an object with no prototype', Object.create(null), 'a value of type object'],
      ['a symbol', Symbol('ttl'), 'a value of type symbol'],
    ])('%s throws', (_label, value, shownAs) => {
      const err = thrownBy(() => epb.configure({ cacheTtl: value }));
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.message).toContain('cacheTtl');
      expect(err.message).toContain(shownAs);
    });

    test.each([
      ['null', null],
      ['a negative number', -5],
      ['a string', 'abc'],
      ['a float', 3.5],
    ])('%s is refused without replacing the previously configured value', (_label, value) => {
      epb.configure({ cacheTtl: 60 });

      expect(() => epb.configure({ cacheTtl: value })).toThrow(ConfigurationError);
      expect(config.cacheTtl).toBe(60);
    });

    // The same all-or-nothing rule an unknown key gets: a caller that catches
    // the error must not be left half-configured. The other key has to be one
    // configure() assigns before cacheTtl, or the cacheTtl setter's own throw
    // would stop the loop before reaching it anyway; applicationVersion is,
    // and has no env-var fallback to muddy the read. `null` is here as well
    // as `-5` so a pre-check that skips null (`!= null`) is caught too.
    test.each([
      ['a negative number', -5],
      ['null', null],
    ])('a bad cacheTtl (%s) applies nothing else from the same configure() call', (_label, value) => {
      expect(() => epb.configure({ applicationVersion: '3.4.1', cacheTtl: value }))
        .toThrow(ConfigurationError);
      expect(config.applicationVersion).toBeNull();
      expect(config.cacheTtl).toBe(300);
    });
  });
});

// sc-1266: follow-up to sc-970. Rails and Java were found to apply fields
// assigned before an invalid one, leaving a caller that catches the
// ConfigurationError with a half-updated configuration. Every SDK gets this
// exact test regardless of whether it already behaved this way, so a future
// regression in *this* SDK is caught by a test that was written for it, not
// only by the narrower cacheTtl-specific one above.
//
// workerCount is assigned earlier than cacheTtl in CONFIGURE_KEYS, so if
// configure()'s cacheTtl pre-check were ever removed (leaving only the
// cacheTtl setter's own validation, reached partway through the assignment
// loop), workerCount would already be assigned by the time cacheTtl threw --
// this test would then fail. It has no ENDPOINTBLANK_* env var fallback, so
// it can't pass or fail depending on the machine it runs on.
describe('sc-1266: configure() is all-or-nothing', () => {
  test('a configure() call with one valid field and one invalid field applies neither', () => {
    expect(config.workerCount).toBe(4); // the default, confirmed before mutating it

    expect(() => epb.configure({ workerCount: 9, cacheTtl: -1 }))
      .toThrow(ConfigurationError);

    expect(config.workerCount).toBe(4);
    expect(config.cacheTtl).toBe(300);
  });
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
