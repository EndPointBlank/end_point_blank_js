'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { instance: authCache } = require('../../src/commands/authentication-cache');
const { BasicAuthenticate } = require('../../src/commands/basic-authenticate');
const { EndpointAuthorize } = require('../../src/commands/endpoint-authorize');

/**
 * `BasicAuthenticate` and `EndpointAuthorize` POST to the *same* intake
 * endpoint — `config.authorizeUrl`, i.e. `POST /authorize` — so they are two
 * transcriptions of one wire contract, and they drifted: `authenticate` sent
 * `action`, `version` and `ip_address` where `authorize` sent `http_method`,
 * `endpoint_version` and `source_ip`.
 *
 * Intake reads only the second spelling and ignores every other key in the
 * body, so the drift was not a rename. `endpoint_version` and `source_ip` were
 * simply never sent — intake recorded both columns as nil on every authenticate
 * row — and `http_method` is worse than that: every clause of
 * `AuthorizeAccess.authorize/1` pattern-matches it, so a body without it falls
 * through to `def authorize(_params), do: {:error, :invalid_params}` and the
 * controller answers 401. The authenticate path could not succeed against real
 * intake whatever credential it presented.
 *
 * The names are asserted here as string literals, against both commands, and
 * the old names are asserted *absent*. This is the analogue of
 * `tests/express/refusal-parity.test.js` one layer down: the two commands are
 * driven together so the next divergence cannot land on one of them alone.
 *
 * What this file cannot do is notice that the pair have agreed on a name intake
 * does not read — a double answers whatever it is asked. That is what
 * `tests/express/authenticate-intake-contract.test.js` is for: it puts a stub
 * that refuses the way intake refuses on the other end of a real socket.
 */

/** The keys intake actually reads on `POST /authorize`, and where. */
const KEYS_INTAKE_READS = [
  // authorization_controller.ex:17
  'client_auth',
  // normalized authorization_controller.ex:20; matched authorize_access.ex:16
  // and :61; stored authorizations.ex:135
  'path',
  // matched authorize_access.ex:17 and :62; stored authorizations.ex:136
  'http_method',
  // authorization_controller.ex:60 (deprecation lookup); stored
  // authorizations.ex:137
  'endpoint_version',
  // stored authorizations.ex:141, as source_ip_address
  'source_ip',
];

/** The spellings this command used to send. Intake reads none of them. */
const KEYS_INTAKE_IGNORES = ['action', 'version', 'ip_address'];

describe('the intake POST /authorize parameter contract', () => {
  const req = (overrides = {}) => ({
    headers: {
      authorization: 'Basic Y2xpZW50',
      host: 'api.example.test',
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      ...overrides.headers,
    },
    method: 'PATCH',
    originalUrl: '/api/v3/students/7',
    ...overrides,
  });

  const bodySent = () => post.mock.calls[0][2];

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.baseUrl = 'https://epb.test';

    authCache.clear();
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    authCache.clear();
    config._reset();
  });

  /**
   * Both commands take (req, path, version) and both POST to `authorizeUrl`.
   * Driving them through one table is the whole point: a name can only be
   * changed on one of them by making this table disagree with itself.
   *
   * Only the `BasicAuthenticate` rows are regression tests — 7 of its 10 go red
   * against master. Every `EndpointAuthorize` row passes against master, since
   * that command has always spelled these keys correctly; those rows are
   * **guards**, and they are here for the drift in the other direction. This
   * pair has already diverged three times (the wire keys fixed here, the
   * refusal status in sc-307, and the single-read of the response body in the
   * same PR), always by one command being repaired and the other left alone.
   */
  const commands = [
    ['BasicAuthenticate', (request, path, version) => BasicAuthenticate.authenticate(request, path, version)],
    ['EndpointAuthorize', (request, path, version) => EndpointAuthorize.authorize(request, path, version)],
  ];

  describe.each(commands)('%s', (_name, call) => {
    test('posts to intake’s authorize endpoint', async () => {
      await call(req(), '/students/:id', '3');

      expect(post.mock.calls[0][0]).toBe('https://epb.test/api/authorize');
    });

    test.each(KEYS_INTAKE_READS)('sends the key intake reads as “%s”', async key => {
      await call(req(), '/students/:id', '3');

      expect(Object.keys(bodySent())).toContain(key);
    });

    test.each(KEYS_INTAKE_IGNORES)('does not send “%s”, which intake ignores', async key => {
      await call(req(), '/students/:id', '3');

      expect(Object.keys(bodySent())).not.toContain(key);
    });

    test('gives each of those keys the value it is meant to carry', async () => {
      await call(req(), '/students/:id', '3');

      const body = bodySent();

      expect(body.client_auth).toBe('Basic Y2xpZW50');
      expect(body.path).toBe('/students/:id');
      expect(body.http_method).toBe('PATCH');
      expect(body.endpoint_version).toBe('3');
      expect(body.source_ip).toBe('203.0.113.7');
    });
  });

  test('the two commands agree, key for key, on everything intake reads', async () => {
    await BasicAuthenticate.authenticate(req(), '/students/:id', '3');
    const authenticateBody = bodySent();

    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    await EndpointAuthorize.authorize(req(), '/students/:id', '3');
    const authorizeBody = bodySent();

    const readByIntake = body =>
      Object.fromEntries(KEYS_INTAKE_READS.map(key => [key, body[key]]));

    // Not a subset check. Both sides are projected onto the same key list, so
    // a key missing from one shows up as `undefined` against the other's value
    // rather than quietly dropping out of the comparison.
    expect(readByIntake(authenticateBody)).toEqual(readByIntake(authorizeBody));
  });

  test('neither command sends both spellings of the same field', async () => {
    // Sending `action` alongside `http_method` would make the wire look fixed
    // while leaving the old name in place for the next port to copy. Intake
    // would accept it — it ignores unknown keys — which is exactly why nothing
    // downstream would ever complain.
    for (const [, call] of commands) {
      post.mockReset();
      post.mockResolvedValue({ status: 201, ok: true });
      authCache.clear();

      await call(req(), '/students/:id', '3');

      expect(Object.keys(bodySent())).toEqual(
        expect.not.arrayContaining(KEYS_INTAKE_IGNORES),
      );
    }
  });
});
