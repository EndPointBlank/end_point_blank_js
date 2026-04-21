'use strict';

const { instance: config, LogMode } = require('../configuration');
const { RequestStore } = require('../request-store');
const { VersionFinder } = require('../commands/version-finder');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');

/**
 * Sends request payloads to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::RequestWriter`.
 */
const RequestWriter = {
  /**
   * @param {import('express').Request} req
   * @returns {Promise<void>}
   */
  async write(req) {
    try {
      if (!req) return;
      const version = VersionFinder.find(req);
      const headers = req.headers ? { ...req.headers } : {};
      const payload = {
        app_name: config.appName,
        env: config.environment,
        uuid: RequestStore.getUuid() || headers['x-request-id'] || req.id || null,
        host: req.hostname || req.host || null,
        headers,
        path: req.path || req.url || null,
        http_method: req.method || null,
        endpoint_version: version,
        request: _readBody(req),
        sent_at: new Date().toISOString(),
      };
      await _writer().write([payload]);
    } catch (err) {
      console.error('[EndPointBlank] RequestWriter failed:', err.message);
    }
  },
};

function _writer() {
  return config.logMode === LogMode.DELAYED
    ? new DelayedWriter('requestsUrl')
    : new DirectWriter('requestsUrl');
}

function _readBody(req) {
  try {
    if (req.body === undefined || req.body === null) return null;
    if (typeof req.body === 'string') return req.body;
    return JSON.stringify(req.body);
  } catch (_err) {
    return null;
  }
}

module.exports = { RequestWriter };
