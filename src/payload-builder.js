'use strict';

const { randomUUID } = require('crypto');
const { instance: config } = require('./configuration');
const { RequestStore } = require('./request-store');

/**
 * Builds the payload object sent to intake's error ingest,
 * `POST /api/application_errors`.
 *
 * This module is public API — `package.json` exposes `./src/*` — and it is the
 * documented way to build an error row without going through
 * {@link module:writers/exception-writer}. That makes it a second
 * transcription of one wire contract, and it had drifted from the first:
 *
 * - It sent no `uuid`. Intake's `ApplicationError` changeset ends
 *   `validate_required([:message, :uuid, :app_name, :sent_at])`
 *   (`intake/lib/intake/errors/application_error.ex:46`), so every row built
 *   here was refused outright.
 * - Eight of the twelve keys it did send — `url`, `status`, `request_headers`,
 *   `env`, `path`, `action`, `endpoint_version` and `request` — are not read by
 *   `application_error_controller.ex`'s `build_attrs/2`, which is an explicit
 *   allowlist. They were dropped on arrival.
 *
 * The payload below is exactly `build_attrs/2`'s allowlist, less the two keys
 * intake fills in itself (`stack_hash`, computed server-side from the trace,
 * and `target_application_environment_id`, stamped from the credential).
 *
 * Two of the eight had somewhere to go and were renamed rather than dropped:
 * `path` is `stamped_path` and `action` is `stamped_http_method`. The other six
 * have no column on `application_errors` at all. What they carry lives on the
 * request and response rows for the same request, which the `uuid` here joins
 * to: `url` as `host`/`scheme`/`port`/`path`, `request` as `request`,
 * `request_headers` as `headers` and `endpoint_version` as `endpoint_version`
 * on `application_requests`; `status` on `application_responses`. `env` is no
 * longer taken from the client anywhere in the ingest path — intake derives an
 * environment from the credential the call presents.
 *
 * There is no `EndPointBlank::PayloadBuilder` in the Ruby gem, whatever this
 * file used to claim: the gem shapes an error payload in
 * `Writers::ExceptionWriter#payload`, and that is what this now matches.
 */
const PayloadBuilder = {
  /**
   * @param {object} opts
   * @param {string} opts.message
   * @param {Error|null} [opts.error] - Source of `stacktrace` when none is given.
   * @param {string[]|null} [opts.stacktrace] - Frames, one per entry.
   * @param {Date} [opts.sentAt]
   * @param {string|null} [opts.path] - Route being served; sent as `stamped_path`.
   * @param {string|null} [opts.action] - HTTP method; sent as `stamped_http_method`.
   * @param {string|null} [opts.uuid] - Correlation id; resolved when omitted.
   *
   * The `uuid` resolves to the id `RequestStore.run` minted for the request in
   * flight — the same value `RequestWriter`, `ResponseWriter` and
   * `ExceptionWriter` send, which is what joins this row to the request and
   * response rows for the same call — and to a freshly minted one when there is
   * no request in flight.
   *
   * `ExceptionWriter` sends `null` in that second case, and this deliberately
   * does not: `uuid` is required, so `null` is a refused row, and building
   * outside a request is the normal case for a caller reaching for this module
   * directly. An id that correlates with nothing still records the error.
   * `crypto.randomUUID` is the same source `RequestStore` mints from, so this is
   * that scheme reaching one step further rather than a second one. A caller
   * with its own correlation id — an inbound `X-Request-Id`, say — passes it in.
   *
   * `status`, `headers` and `version` are still accepted so existing calls keep
   * working, but they are no longer sent: intake's error ingest has no column
   * for any of them. See the note above for where each one is recorded instead.
   *
   * @returns {object}
   */
  build({ message, error, stacktrace, sentAt, path, action, uuid }) {
    const req = RequestStore.get();

    const resolvedStacktrace = stacktrace
      ?? (error?.stack ? error.stack.split('\n').slice(1).map(l => l.trim()).filter(Boolean) : null);

    return {
      message,
      uuid: uuid || RequestStore.getUuid() || randomUUID(),
      app_name: config.appName,
      sent_at: (sentAt || new Date()).toISOString(),
      stacktrace: resolvedStacktrace || null,
      stamped_path: path ?? (req ? req.path || req.originalUrl || null : null),
      stamped_http_method: action ?? (req ? req.method || null : null),
      source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
    };
  },
};

module.exports = { PayloadBuilder };
