'use strict';

const { instance: config } = require('./configuration');
const { RequestStore } = require('./request-store');
const { SessionConfiguration } = require('./session-configuration');

/**
 * Builds the payload object sent to the EndPointBlank API for error reporting.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::PayloadBuilder`.
 */
const PayloadBuilder = {
  /**
   * @param {object} opts
   * @param {string} opts.message
   * @param {Error|null} [opts.error]
   * @param {string[]|null} [opts.stacktrace]
   * @param {number} opts.status
   * @param {object} [opts.headers]
   * @param {Date} [opts.sentAt]
   * @param {string|null} [opts.path]
   * @param {string|null} [opts.action]
   * @param {string|null} [opts.version]
   * @returns {object}
   */
  build({ message, error, stacktrace, status, headers = {}, sentAt, path, action, version }) {
    const req = RequestStore.get();

    const resolvedStacktrace = stacktrace
      ?? (error?.stack ? error.stack.split('\n').slice(1).map(l => l.trim()).filter(Boolean) : null);

    return {
      message,
      url: req ? buildUrl(req) : null,
      stacktrace: resolvedStacktrace || null,
      status,
      app_name: config.appName,
      request_headers: headers,
      env: SessionConfiguration.envName(),
      path: path ?? null,
      action: action ?? null,
      endpoint_version: version ?? null,
      request: req ? readBody(req) : null,
      sent_at: (sentAt || new Date()).toISOString(),
    };
  },
};

function buildUrl(req) {
  const protocol = req.protocol || (req.connection?.encrypted ? 'https' : 'http');
  const host = req.headers?.host || req.hostname || 'localhost';
  const originalUrl = req.originalUrl || req.url || '';
  return `${protocol}://${host}${originalUrl}`;
}

function readBody(req) {
  if (req.body === undefined) return null;
  if (typeof req.body === 'string') return req.body;
  try {
    return JSON.stringify(req.body);
  } catch {
    return null;
  }
}

module.exports = { PayloadBuilder };
