'use strict';

const { instance: config, LogMode } = require('../configuration');
const { PayloadBuilder } = require('../payload-builder');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');

/**
 * Factory writer that delegates to {@link DirectWriter} or {@link DelayedWriter}
 * based on the configured {@link LogMode}.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::Writer`.
 */
class Writer {
  /**
   * @param {string} urlKey - URL key passed to the underlying writer.
   */
  constructor(urlKey) {
    this._urlKey = urlKey;
    this._writer = null;
  }

  /**
   * Builds a payload and sends it via the appropriate writer.
   *
   * @param {object} opts
   * @param {string} opts.message
   * @param {Error|null} [opts.error]
   * @param {number} opts.status
   * @param {object} [opts.headers]
   * @param {string|null} [opts.path]
   * @param {string|null} [opts.action]
   * @param {string|null} [opts.version]
   * @param {Date} [opts.sentAt]
   * @returns {Promise<void>}
   */
  async write({ message, error, status, headers, path, action, version, sentAt }) {
    const payload = PayloadBuilder.build({ message, error, status, headers, path, action, version, sentAt });
    await this._getWriter().write([payload]);
  }

  _getWriter() {
    if (!this._writer) {
      this._writer = config.logMode === LogMode.DELAYED
        ? new DelayedWriter(this._urlKey)
        : new DirectWriter(this._urlKey);
    }
    return this._writer;
  }
}

module.exports = { Writer };
