'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');

/**
 * Authorizes an incoming request by sending its details to the EndPointBlank
 * authorize API.
 *
 * Sends the request path, HTTP method, client Authorization header, application
 * name, API version, source IP, and target hostname to the configured
 * `authorizeUrl`.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::EndpointAuthorize`.
 */
const EndpointAuthorize = {
  /**
   * @param {object} req - Express `Request` or Node `IncomingMessage`.
   * @param {string} path - Route pattern path (e.g. `/api/v1/users`).
   * @param {string|null} version - Detected API version.
   * @returns {Promise<Response|null>}
   */
  async authorize(req, path, version) {
    const clientAuth = req.headers?.authorization;
    const host = (req.headers?.host || req.hostname || '').replace(/:\d+$/, '');
    const authHeader = await Authorization.header();

    const body = {
      path,
      http_method: req.method,
      client_auth: clientAuth,
      target_hostname: host,
      application: config.appName,
      endpoint_version: version,
      source_ip: remoteAddr(req),
    };

    const response = await post(config.authorizeUrl, authHeader, body);
    if (!response) return null;

    console.info(`[EndPointBlank] Authorization response: ${response.status}`);
    if (response.status > 299) {
      const text = await response.text().catch(() => '');
      console.error(`[EndPointBlank] Authorization failed: ${response.status} - ${text}`);
    }
    return response;
  },
};

function remoteAddr(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

module.exports = { EndpointAuthorize };
