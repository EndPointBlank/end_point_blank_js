'use strict';

const { instance: config, LogMode } = require('../configuration');
const { RequestStore } = require('../request-store');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');

/**
 * Sends structured log entries to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::LogWriter`.
 *
 * @example
 * const { LogWriter } = require('end-point-blank-js/writers/log-writer');
 * await LogWriter.info('Payment processed', { amount: 42 });
 */
const LogWriter = {
  /** @param {string} message @param {object} [data] @returns {Promise<void>} */
  async info(message, data = {}) { return this.write(message, 'info', data); },

  /** @param {string} message @param {object} [data] @returns {Promise<void>} */
  async warn(message, data = {}) { return this.write(message, 'warn', data); },

  /** @param {string} message @param {object} [data] @returns {Promise<void>} */
  async error(message, data = {}) { return this.write(message, 'error', data); },

  /** @param {string} message @param {object} [data] @returns {Promise<void>} */
  async fatal(message, data = {}) { return this.write(message, 'fatal', data); },

  /**
   * @param {string} message
   * @param {string} level - One of `'info'`, `'warn'`, `'error'`, `'fatal'`.
   * @param {object} [data={}]
   * @returns {Promise<void>}
   */
  async write(message, level, data = {}) {
    try {
      const req = RequestStore.get();
      const stamped = req
        ? { stamped_path: req.path || req.originalUrl, stamped_http_method: req.method }
        : {};
      const payload = {
        message,
        log_level: level,
        sent_at: new Date().toISOString(),
        app_name: config.appName,
        // The one writer that does not consult `RequestStore.getUuid()`, and
        // it is left that way on purpose — but the divergence is real and
        // should be recorded rather than read as an oversight.
        //
        // `RequestWriter`, `ResponseWriter` and `ExceptionWriter` all send the
        // uuid `RequestStore.run` minted for the request. This sends the
        // caller's inbound id instead, so a log line emitted during a request
        // carries a value none of the other three rows for that same request
        // carries, and intake joins an interaction to its logs on nothing but
        // that value. In-request log rows therefore do not assemble into the
        // interaction they belong to — either they hold an id from a namespace
        // intake has no other row in, or, when no proxy set one, null.
        //
        // Not fixed under sc-353 because it is not the same defect.
        // `application_logs` validates nothing at all —
        // `validate_required([])`, `intake/lib/intake/apis/application_log.ex:42`
        // — so unlike the error and request streams nothing here is refused;
        // the rows land, uncorrelated. Reconciling the two is a behaviour
        // change for every user whose proxy sets `X-Request-Id`, and it wants
        // its own story. Python's log writer has the same shape and the same
        // question; Ruby, Java and Elixir route logs through the shared
        // resolver and do not.
        uuid: req ? (req.headers && req.headers['x-request-id']) || req.id || null : null,
        data,
        source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
        ...stamped,
      };
      await _writer().write([payload]);
    } catch (err) {
      console.error('[EndPointBlank] LogWriter failed:', err.message);
    }
  },
};

function _writer() {
  return config.logMode === LogMode.DELAYED
    ? new DelayedWriter('logUrl')
    : new DirectWriter('logUrl');
}

module.exports = { LogWriter };
