'use strict';

const { instance: config, LogMode } = require('../configuration');
const { RequestStore } = require('../request-store');
const { RoutePatternFinder } = require('../commands/route-pattern-finder');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');

/**
 * Sends response payloads to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::ResponseWriter`.
 */
const ResponseWriter = {
  /**
   * @param {number} status - HTTP status code.
   * @param {object} headers - Response headers map.
   * @param {string|null} body - Response body (will be truncated).
   * @param {object} [data={}] - Additional data.
   * @returns {Promise<void>}
   */
  async write(status, headers = {}, body = null, data = {}) {
    try {
      const req = RequestStore.get();
      const route = req ? RoutePatternFinder.find(req) : null;
      const reqHeaders = req && req.headers ? req.headers : {};
      const payload = {
        app_name: config.appName,
        env: config.environment,
        uuid: RequestStore.getUuid() || reqHeaders['x-request-id'] || (req && req.id) || null,
        status,
        headers,
        body: _truncate(body),
        sent_at: new Date().toISOString(),
        route,
        data,
        source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
      };
      await _writer().write([payload]);
    } catch (err) {
      console.error('[EndPointBlank] ResponseWriter failed:', err.message);
    }
  },
};

function _writer() {
  return config.logMode === LogMode.DELAYED
    ? new DelayedWriter('responsesUrl')
    : new DirectWriter('responsesUrl');
}

function _truncate(body) {
  if (body == null) return null;
  if (body.length > 1030) return body;
  return body.length > 1024 ? body.slice(0, 1024) + '...' : body;
}

module.exports = { ResponseWriter };
