'use strict';

const { instance: config } = require('../configuration');
const { RequestStore } = require('../request-store');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');
const { LogMode } = require('../configuration');

/**
 * Sends unhandled application exception payloads to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::ExceptionWriter`.
 */
const ExceptionWriter = {
  /**
   * @param {Error} err
   * @returns {Promise<void>}
   */
  async write(err) {
    try {
      const req = RequestStore.get();
      const payload = {
        app_name: config.appName,
        message: err.message,
        stacktrace: err.stack ? err.stack.split('\n').slice(1).map(l => l.trim()).filter(Boolean) : null,
        sent_at: new Date().toISOString(),
        source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
        uuid: RequestStore.getUuid() || (req && req.headers && req.headers['x-request-id']) || (req && req.id) || null,
      };
      await _writer().write([payload]);
    } catch (reportingErr) {
      console.error('[EndPointBlank] ExceptionWriter failed:', reportingErr.message);
    }
  },
};

function _writer() {
  return config.logMode === LogMode.DELAYED
    ? new DelayedWriter('applicationErrorsUrl')
    : new DirectWriter('applicationErrorsUrl');
}

module.exports = { ExceptionWriter };
