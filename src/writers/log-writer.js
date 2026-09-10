'use strict';

const { randomUUID } = require('crypto');
const { instance: config, LogMode } = require('../configuration');
const { RequestStore } = require('../request-store');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');
const { applyMasking } = require('../masking');

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
        // Same source as `RequestWriter`/`ResponseWriter`/`ExceptionWriter`:
        // this row now carries the SDK's own per-request uuid rather than the
        // caller's inbound `X-Request-Id`, so all four rows for one
        // interaction share an id and can be joined. That is a deliberate
        // trade-off, not an oversight — a customer's own inbound trace id no
        // longer appears on log rows. It never appeared on the other three
        // streams either, so this removes the one outlier rather than making
        // log rows less capable than they used to be relative to the rest of
        // the SDK. Keeping the caller's id alongside our own, as a second
        // field, is real future work and is deliberately out of scope here.
        // See sc-380.
        //
        // Falls back to a minted id outside a request context, same as
        // `ExceptionWriter` under sc-353: a log call outside a request
        // (background jobs, workers, startup) is exactly as possible as an
        // exception one, and should not resolve to `null` either.
        uuid: RequestStore.getUuid() || randomUUID(),
        data,
        source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
        ...stamped,
      };
      // Applied after `...stamped` is already folded in above, matching the
      // merge-then-mask order `ExceptionWriter` and `PayloadBuilder.build`
      // use for the same stamped fields (sc-382). `FIELD_MAP.log` is `{}`, so
      // rule-based masking has nothing to target here yet, but `maskHook` is
      // arbitrary caller code that runs regardless of `FIELD_MAP` — a log
      // entry's free-form `data` blob is exactly what a hook exists to scrub.
      const maskedPayload = applyMasking(payload, 'log', config.maskingRules, config.maskHook);
      await _writer().write([maskedPayload]);
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
