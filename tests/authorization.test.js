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
const TAIL =
  "EndPointBlank never sends this service's client_id/client_secret to a provider, " +
  'so there is no Basic-auth fallback and the call must not be made without a token.';
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

  test('strips userinfo, query and fragment before the token request, and still mints (sc-1469)', async () => {
    respondWith(() => minted('tok-1'));

    const raw = 'https://user:hunter2@api.provider.test/orders?api_key=s3cret#frag';
    await expect(Authorization.header(raw)).resolves.toBe('Bearer tok-1');

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ base_url: PROVIDER_URL });
    const sent = globalThis.fetch.mock.calls.map(([url, options]) => `${url} ${JSON.stringify(options)}`).join('\n');
    for (const secret of ['hunter2', 'api_key', 's3cret', 'frag']) {
      expect(sent).not.toContain(secret);
    }
  });

  test.each([
    ['an empty query', `${PROVIDER_URL}?`],
    ['an empty fragment', `${PROVIDER_URL}#`],
  ])('strips %s too: intake refuses even an empty one', async (_label, raw) => {
    respondWith(() => minted('tok-1'));

    await Authorization.header(raw);

    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body)).toEqual({ base_url: PROVIDER_URL });
  });

  test.each([
    ['a relative path', '/orders'],
    ['no host', 'mailto:ops@provider.test'],
    ['unparseable text', 'not a url ?token=s3cret'],
  ])('refuses %s with a TypeError and makes no request (sc-1469)', async (_label, arg) => {
    respondWith(() => minted('tok-1'));

    const err = await Authorization.header(arg).catch(e => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/absolute URL with a scheme and host/);
    expect(err.message).not.toContain('s3cret');
    expect(requests).toHaveLength(0);
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
      expect(err.message.startsWith(
        `Could not mint an EndPointBlank access token for ${PROVIDER_URL}: `,
      )).toBe(true);
      expect(err.message).toMatch(why);
      expect(err.message.endsWith(TAIL)).toBe(true);
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
      jest.spyOn(AccessTokens, 'tokenWithResult').mockRejectedValue(boom);

      const err = await Authorization.header(PROVIDER_URL).catch(e => e);

      expect(err).toBeInstanceOf(TokenUnavailableError);
      expect(err.outcome).toBe(TokenOutcome.TRANSPORT_ERROR);
      expect(err.status).toBeNull();
      expect(err.cause).toBe(boom);
      expect(err.message).toBe(
        `Could not mint an EndPointBlank access token for ${PROVIDER_URL}: ` +
          `the token request failed unexpectedly. ${TAIL}`,
      );
      // The cause's own text stays on the cause, not in this message.
      expect(err.message).not.toContain('socket hang up');
    });

    test('a token revoked mid-flight is not replaced by Basic on the next call', async () => {
      respondWith(() => minted('tok-1'));
      await Authorization.header(PROVIDER_URL);

      AccessTokens.invalidate('tok-1');
      respondWith(() => json(401, { error: 'invalid_credentials' }));

      await expect(Authorization.header(PROVIDER_URL)).rejects.toBeInstanceOf(TokenUnavailableError);
      expectBasicOnlyToIntake();
    });

    test('the reason comes from this call, not from lastFailure() read afterwards', async () => {
      respondWith(() => json(503, { error: 'down' }));
      // A concurrent call clearing or replacing the shared record between the
      // mint and the throw must not change what this call reports.
      jest.spyOn(AccessTokens, 'lastFailure').mockReturnValue(
        { outcome: TokenOutcome.CREDENTIAL_REJECTED, status: 401 },
      );

      const err = await Authorization.header(PROVIDER_URL).catch(e => e);

      expect(err.outcome).toBe(TokenOutcome.SERVER_ERROR);
      expect(err.status).toBe(503);
      expect(AccessTokens.lastFailure).not.toHaveBeenCalled();
    });

    test('lastFailure() still records the failed mint for other readers', async () => {
      respondWith(() => json(422, { error: 'no grant' }));

      await Authorization.header(PROVIDER_URL).catch(() => {});

      expect(AccessTokens.lastFailure(PROVIDER_URL)).toEqual(
        { outcome: TokenOutcome.REQUEST_REJECTED, status: 422 },
      );
    });
  });

  describe('host code: build the header, then call the provider', () => {
    // Models the documented pattern: the provider request is only made once
    // header() has produced a value, so a failed mint means no provider call.
    async function callProvider() {
      const authorization = await Authorization.header(PROVIDER_URL);
      return globalThis.fetch(PROVIDER_URL, { headers: { Authorization: authorization } });
    }

    const providerRequests = () =>
      requests.filter(({ url }) => new URL(url).host === 'api.provider.test');

    test('on failure the provider receives nothing', async () => {
      respondWith(url => (new URL(url).origin === new URL(INTAKE).origin ? json(401, { error: 'invalid_credentials' }) : json(200, {})));

      await expect(callProvider()).rejects.toBeInstanceOf(TokenUnavailableError);

      expect(providerRequests()).toEqual([]);
      expectBasicOnlyToIntake();
    });

    test('on success the provider receives Bearer, never Basic', async () => {
      respondWith(url => (new URL(url).origin === new URL(INTAKE).origin ? minted('tok-1') : json(200, {})));

      await callProvider();

      expect(providerRequests()).toEqual([{ url: PROVIDER_URL, authorization: 'Bearer tok-1' }]);
      for (const { url, authorization } of requests) {
        if (authorization && authorization.startsWith('Basic ')) {
          expect(new URL(url).origin).toBe(new URL(INTAKE).origin);
        }
      }
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

  // The same six texts, word for word, in every EndPointBlank SDK (sc-1469).
  test.each([
    ['credential_rejected', { outcome: 'credential_rejected', status: 401 },
      "intake rejected this application's client credential (HTTP 401); retrying cannot help -- re-issue the credential"],
    ['request_rejected', { outcome: 'request_rejected', status: 422 },
      'intake refused the token request (HTTP 422); check the URL and that a grant covers the target'],
    ['server_error', { outcome: 'server_error', status: 503 },
      'intake failed to issue a token (HTTP 503); this may be transient'],
    ['server_error with no status', { outcome: 'server_error', status: null },
      'intake failed to issue a token; this may be transient'],
    ['transport_error', { outcome: 'transport_error' },
      'intake could not be reached (timeout, connection refused or retries exhausted); this may be transient'],
    ['a mint that threw', { outcome: 'transport_error', cause: new Error('boom') },
      'the token request failed unexpectedly'],
    ['no result recorded', {},
      'the token request failed for an unknown reason'],
  ])('words the reason exactly: %s', (_label, details, why) => {
    const err = new TokenUnavailableError(PROVIDER_URL, details);

    expect(err.message).toBe(
      `Could not mint an EndPointBlank access token for ${PROVIDER_URL}: ${why}. ${TAIL}`,
    );
  });

  test('neither the message nor baseUrl repeats userinfo, query or fragment from the URL', () => {
    const raw = 'https://user:hunter2@api.provider.test:8443/v1/things?api_key=s3cret#frag';
    const err = new TokenUnavailableError(raw, { outcome: 'server_error', status: 503 });

    expect(err.message).toContain('for https://api.provider.test:8443/v1/things: ');
    for (const secret of ['user', 'hunter2', 'api_key', 's3cret', 'frag']) {
      expect(err.message).not.toContain(secret);
    }
    // Nor does the error's own field: reporters capture it too (sc-1469).
    expect(err.baseUrl).toBe('https://api.provider.test:8443/v1/things');
  });

  test('an unparseable URL is left out of the message entirely', () => {
    const err = new TokenUnavailableError('not a url ?token=s3cret');

    expect(err.message).not.toContain('s3cret');
    expect(err.message).toContain('could not be parsed');
    expect(err.baseUrl).toBeNull();
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
