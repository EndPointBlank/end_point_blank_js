'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { RequestStore } = require('../../src/request-store');
const { PayloadBuilder } = require('../../src/payload-builder');
const { ExceptionWriter } = require('../../src/writers/exception-writer');

/**
 * `PayloadBuilder` and `ExceptionWriter` both produce a row for intake's
 * `POST /api/application_errors`, so they are two transcriptions of one wire
 * contract — and they drifted. `ExceptionWriter` sent a `uuid`; the builder
 * sent none, and intake requires one, so every row an integrator built through
 * the exported builder was refused. Eight further keys the builder sent are not
 * read at all.
 *
 * The keys are asserted here as string literals taken from intake's source, and
 * both producers are driven through the same table, so the next divergence
 * cannot land on one of them alone. Asserting against a double proves nothing
 * about this: a stub answers whatever it is asked, which is precisely how a
 * payload missing a required field passed its tests for the life of the defect.
 *
 * What this file cannot do is notice that both producers have agreed on a name
 * intake does not read. Only reading intake catches that, which is why every
 * entry below carries the file and line it was read from.
 */

/**
 * `validate_required/2` on the ApplicationError changeset —
 * `intake/lib/intake/errors/application_error.ex:46`. A row missing any of
 * these is rejected, and since sc-310 a batch of nothing but rejected rows
 * comes back 422 rather than the 201 it used to answer.
 */
const KEYS_INTAKE_REQUIRES = ['message', 'uuid', 'app_name', 'sent_at'];

/**
 * Everything `build_attrs/2` reads off a payload —
 * `intake/lib/intake_web/controllers/application_error_controller.ex:79-94`.
 * That function is an allowlist: a key not named there never reaches the
 * changeset, whatever the schema says.
 *
 * `stack_hash` and `target_application_environment_id` are in the allowlist but
 * deliberately absent here — intake computes the first from the trace and
 * stamps the second from the credential, so a client-sent value is overwritten.
 */
const KEYS_INTAKE_READS = [
  ...KEYS_INTAKE_REQUIRES,
  'stacktrace',
  'stamped_path',
  'stamped_http_method',
  'source_application_environment_id',
];

/**
 * What the builder used to send. `build_attrs/2` reads none of them, so all
 * eight were dropped on arrival. `path` and `action` are renames — intake reads
 * those as `stamped_path` and `stamped_http_method`. The other six have no
 * column on `application_errors`; the request and response rows the `uuid`
 * joins to carry that data instead.
 */
const KEYS_INTAKE_IGNORES = [
  'url',
  'status',
  'request_headers',
  'env',
  'path',
  'action',
  'endpoint_version',
  'request',
];

describe('the intake POST /api/application_errors payload contract', () => {
  const req = (overrides = {}) => ({
    protocol: 'https',
    headers: { host: 'api.example.test' },
    method: 'PATCH',
    path: '/v1/students/7',
    originalUrl: '/v1/students/7?q=1',
    ...overrides,
  });

  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.environment = 'staging';
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.logBaseUrl = 'https://log.epb.test';
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  /**
   * Both producers are driven inside a request context, and each hands back the
   * row it produced alongside the uuid `RequestStore` minted for that context.
   *
   * Inside a request is the only place their shapes are comparable:
   * `ExceptionWriter` adds `stamped_path`/`stamped_http_method` only when there
   * is a request to stamp, so outside one the two legitimately differ.
   */
  const producers = [
    ['PayloadBuilder', request =>
      RequestStore.run(request, async () => ({
        payload: PayloadBuilder.build({ message: 'boom', error: new Error('boom') }),
        minted: RequestStore.getUuid(),
      }))],
    ['ExceptionWriter', request =>
      RequestStore.run(request, async () => {
        await ExceptionWriter.write(new Error('boom'));
        return { payload: post.mock.calls[0][2].payload[0], minted: RequestStore.getUuid() };
      })],
  ];

  describe.each(producers)('%s', (_name, produce) => {
    test.each(KEYS_INTAKE_REQUIRES)('sends “%s”, which intake requires', async key => {
      const { payload } = await produce(req());

      expect(Object.keys(payload)).toContain(key);
    });

    test.each(KEYS_INTAKE_REQUIRES)('gives “%s” a value, since a null one is refused too', async key => {
      // `validate_required` rejects nil as firmly as an absent key, so a
      // present-but-null field buys nothing. `expect.anything()` is the
      // matcher that refuses both null and undefined, so this stays a real
      // check even when the key is missing outright.
      const { payload } = await produce(req());

      expect(payload[key]).toEqual(expect.anything());
      expect(payload[key]).not.toBe('');
    });

    test.each(KEYS_INTAKE_IGNORES)('does not send “%s”, which intake drops', async key => {
      const { payload } = await produce(req());

      expect(Object.keys(payload)).not.toContain(key);
    });

    test('sends nothing intake does not read', async () => {
      // The inverse of the check above, and the one that catches a key nobody
      // thought to add to the ignore list.
      const { payload } = await produce(req());

      for (const key of Object.keys(payload)) {
        expect(KEYS_INTAKE_READS).toContain(key);
      }
    });

    test('stamps the route being served under the names intake reads', async () => {
      const { payload } = await produce(req());

      expect(payload.stamped_path).toBe('/v1/students/7');
      expect(payload.stamped_http_method).toBe('PATCH');
    });

    test('correlates with the request and response rows for the same request', async () => {
      // The six keys no longer sent are recorded on those rows. The join is
      // this uuid, so it has to be the one `RequestStore` minted for the
      // request, not a fresh one per payload.
      const { payload, minted } = await produce(req());

      expect(minted).toEqual(expect.any(String));
      expect(payload.uuid).toBe(minted);
    });
  });

  test('the two producers agree, key for key, on the row they build', async () => {
    const request = req();

    const { payload: built } = await producers[0][1](request);
    const { payload: written } = await producers[1][1](request);

    expect(Object.keys(built).sort()).toEqual(Object.keys(written).sort());
  });
});
