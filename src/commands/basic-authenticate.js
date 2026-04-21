'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');

/**
 * Authenticates an incoming request by sending its details to the EndPointBlank
 * authorize API using Basic auth credentials.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::BasicAuthenticate`.
 */
const BasicAuthenticate = {
  /**
   * @param {object} req - Express `Request` or Node `IncomingMessage`.
   * @param {string} path - Route pattern path.
   * @param {string|null} version - Detected API version.
   * @param {string|null} [ipAddress] - Override for client IP.
   * @returns {Promise<Response|null>}
   */
  async authenticate(req, path, version, ipAddress = null) {
    const clientAuth = req.headers?.authorization;
    const method = req.method;
    const url = req.originalUrl || req.url || '';

    console.info(
      `[EndPointBlank] Authenticating request: ${method} ${url} with client_auth: ${clientAuth}`,
    );

    const authHeader = await Authorization.header();
    const body = {
      path,
      action: method,
      client_auth: clientAuth,
      application: config.appName,
      version,
      ip_address: ipAddress ?? remoteAddr(req),
    };

    const response = await post(config.authorizeUrl, authHeader, body);
    if (!response) return null;

    console.info(`[EndPointBlank] Authentication response: ${response.status}`);
    if (response.status > 299) {
      const text = await response.text().catch(() => '');
      console.error(`[EndPointBlank] Authentication failed: ${response.status} - ${text}`);
    }
    return response;
  },
};

function remoteAddr(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

module.exports = { BasicAuthenticate };
