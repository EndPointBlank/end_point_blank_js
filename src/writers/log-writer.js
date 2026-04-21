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
      const payload = {
        message,
        log_level: level,
        sent_at: new Date().toISOString(),
        app_name: config.appName,
        uuid: req ? (req.headers && req.headers['x-request-id']) || req.id || null : null,
        data,
        source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
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
