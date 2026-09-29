'use strict';

/**
 * sc-1469: a client calling a provider must never send its own
 * clientId/clientSecret to that provider. `Authorization.header(baseUrl)` is
 * the outbound path, and it answers Bearer or throws -- never Basic.
 * `Authorization.intakeHeader()` is Basic, for the SDK's own calls to intake,
 * which already holds this credential.
 *
 * The network is faked at `fetch`, not at `_http.post`, so every request the
 * SDK actually made -- retries included -- is recorded and can be checked for
 * where a Basic header went.
 */

const { instance: config } = require('../src/configuration');
const { Authorization } = require('../src/authorization');
const { AccessTokens } = require('../src/tokens/access-tokens');
const { TokenOutcome } = require('../src/commands/generate-access-token');
const epb = require('../src/index');
const { TokenUnavailableError } = epb;

const INTAKE = 'https://intake.epb.test';
const PROVIDER_URL = 'https://api.provider.test/orders';
const SECRET = 'test-client-secret';
const BASIC = `Basic ${Buffer.from(`test-client-id:${SECRET}`).toString('base64')}`;

let requests;

function respondWith(handler) {
  globalThis.fetch = jest.fn(async (url, options = {}) => {
    requests.push({ url, authorization: (options.headers || {}).Authorization });
    return handler(url, options);
  });
}

const json = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const minted = token => json(201, {
  token,
  expired_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  base_url: PROVIDER_URL,
});

beforeEach(() => {
  config._reset();
  config.clientId = 'test-client-id';
  config.clientSecret = SECRET;
  config.baseUrl = INTAKE;
  config.logBaseUrl = INTAKE;
  AccessTokens.clear();
  requests = [];
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  AccessTokens.clear();
  config._reset();
});

/** Every Basic header the SDK sent went to intake, and only to intake. */
function expectBasicOnlyToIntake() {
  for (const { url, authorization } of requests) {
    if (typeof authorization === 'string' && authorization.startsWith('Basic ')) {
      expect(new URL(url).origin).toBe(new URL(INTAKE).origin);
    }
    expect(new URL(url).host).not.toBe('api.provider.test');
  }
}

test('basicCredentials returns base64-encoded clientId:clientSecret', () => {
  const decoded = Buffer.from(Authorization.basicCredentials(), 'base64').toString();
  expect(decoded).toBe(`test-client-id:${SECRET}`);
});

describe('header(baseUrl): outbound calls to a provider', () => {
  test('answers Bearer when a token can be obtained', async () => {
    respondWith(() => minted('tok-1'));

    await expect(Authorization.header(PROVIDER_URL)).resolves.toBe('Bearer tok-1');

    // The only request was the mint, to intake, with this app's own credential.
    expect(requests).toEqual([{ url: `${INTAKE}/api/access_token`, authorization: BASIC }]);
    expectBasicOnlyToIntake();
  });

  test('passes the base URL through to the token request untouched', async () => {
    respondWith(() => minted('tok-1'));

    await Authorization.header(PROVIDER_URL);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ base_url: PROVIDER_URL });
  });

  test('reuses a cached token without another mint', async () => {
    respondWith(() => minted('tok-1'));

    await Authorization.header(PROVIDER_URL);
    await expect(Authorization.header(`${PROVIDER_URL}/42`)).resolves.toBe('Bearer tok-1');
    expect(requests).toHaveLength(1);
  });

  describe('when no token can be obtained, it throws and never produces Basic', () => {
    test.each([
      ['a rejected credential (401)', 401, TokenOutcome.CREDENTIAL_REJECTED, /rejected this application's client credential \(HTTP 401\)/],
      ['a rejected request (422)', 422, TokenOutcome.REQUEST_REJECTED, /refused the token request \(HTTP 422\)/],
      ['an intake failure (503)', 503, TokenOutcome.SERVER_ERROR, /failed to issue a token \(HTTP 503\)/],
    ])('%s', async (_label, status, outcome, why) => {
      respondWith(() => json(status, { error: 'nope' }));

      const err = await Authorization.header(PROVIDER_URL).catch(e => e);

      expect(err).toBeInstanceOf(TokenUnavailableError);
      expect(err.name).toBe('TokenUnavailableError');
      expect(err.outcome).toBe(outcome);
      expect(err.status).toBe(status);
      expect(err.baseUrl).toBe(PROVIDER_URL);
      expect(err.message).toMatch(`No access token could be minted for ${PROVIDER_URL}`);
      expect(err.message).toMatch(why);
      expect(err.message).toMatch(/credentials are never sent to a provider/);
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain(Authorization.basicCredentials());
      expectBasicOnlyToIntake();
    });

    test('a timeout (every attempt aborted)', async () => {
      respondWith(() => {
        const abort = new Error('This operation was aborted');
        abort.name = 'AbortError';
        throw abort;
      });

      const err = await Authorization.header(PROVIDER_URL).catch(e => e);

      expect(err).toBeInstanceOf(TokenUnavailableError);
      expect(err.outcome).toBe(TokenOutcome.TRANSPORT_ERROR);
      expect(err.status).toBeNull();
      expect(err.message).toMatch(/could not be reached \(timeout/);
      // post() retried; every attempt went to intake, none to the provider.
      expect(requests.length).toBeGreaterThan(1);
      expectBasicOnlyToIntake();
    });

    test('a 2xx that carried no token', async () => {
      respondWith(() => json(201, { base_url: PROVIDER_URL }));

      const err = await Authorization.header(PROVIDER_URL).catch(e => e);

      expect(err).toBeInstanceOf(TokenUnavailableError);
      expect(err.outcome).toBe(TokenOutcome.SERVER_ERROR);
      expect(err.status).toBe(201);
    });

    test('a mint that throws is wrapped, with the original as cause', async () => {
      const boom = new Error('socket hang up');
      jest.spyOn(AccessTokens, 'token').mockRejectedValue(boom);

      const err = await Authorization.header(PROVIDER_URL).catch(e => e);

      expect(err).toBeInstanceOf(TokenUnavailableError);
      expect(err.outcome).toBeNull();
      expect(err.cause).toBe(boom);
      expect(err.message).toMatch(/the token request failed: socket hang up/);
    });

    test('a token revoked mid-flight is not replaced by Basic on the next call', async () => {
      respondWith(() => minted('tok-1'));
      await Authorization.header(PROVIDER_URL);

      AccessTokens.invalidate('tok-1');
      respondWith(() => json(401, { error: 'invalid_credentials' }));

      await expect(Authorization.header(PROVIDER_URL)).rejects.toBeInstanceOf(TokenUnavailableError);
    });
  });

  test.each([
    ['no argument', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('refuses %s with a TypeError and makes no request', async (_label, arg) => {
    respondWith(() => minted('tok-1'));

    const err = await Authorization.header(arg).catch(e => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/never sent to a provider/);
    expect(requests).toHaveLength(0);
  });

  test('TokenUnavailableError is exported from the package entry point', () => {
    expect(epb.TokenUnavailableError).toBe(require('../src/authorization').TokenUnavailableError);
    expect(new TokenUnavailableError('https://x.test')).toBeInstanceOf(Error);
  });
});

describe("intakeHeader(): the SDK's own calls to intake keep using Basic", () => {
  test('answers Basic from the configured credentials', () => {
    expect(Authorization.intakeHeader()).toBe(BASIC);
  });

  test('the token mint itself authenticates to intake with Basic', async () => {
    const { GenerateAccessToken } = require('../src/commands/generate-access-token');
    respondWith(() => minted('tok-1'));

    await GenerateAccessToken.tokenResult(PROVIDER_URL);

    expect(requests).toEqual([{ url: `${INTAKE}/api/access_token`, authorization: BASIC }]);
  });

  test('authenticate sends Basic to intake', async () => {
    const { BasicAuthenticate } = require('../src/commands/basic-authenticate');
    respondWith(() => json(201, {}));

    await BasicAuthenticate.authenticate(
      { method: 'GET', url: '/students', headers: { authorization: 'Bearer caller' } },
      '/students',
      null,
    );

    expect(requests).toEqual([{ url: `${INTAKE}/api/authorize`, authorization: BASIC }]);
  });

  test('log/request writers send Basic to intake', async () => {
    const { DirectWriter } = require('../src/writers/direct-writer');
    respondWith(() => json(201, {}));

    await new DirectWriter('requestsUrl').write([{ a: 1 }]);

    expect(requests).toEqual([{ url: `${INTAKE}/api/application_requests`, authorization: BASIC }]);
  });
});
