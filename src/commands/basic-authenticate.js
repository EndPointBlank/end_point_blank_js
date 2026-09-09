'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');
const log = require('../log');

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

    log.info(
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

    log.info(`[EndPointBlank] Authentication response: ${response.status}`);
    if (response.status > 299) {
      // Clone before reading, exactly as `EndpointAuthorize` does. A fetch
      // Response body can only be consumed once, and `authenticated.js` reads
      // this one afterwards to build the error the caller sees. Draining it
      // here meant every failure — access_denied, invalid_credentials — reached
      // the caller as "Authentication service unavailable", which is both wrong
      // and the least useful thing to page on.
      //
      // The authorize command was given this fix and this one was not, which is
      // the same asymmetry that lost the status: two copies of one decision,
      // one of them repaired.
      const source = typeof response.clone === 'function' ? response.clone() : response;
      const text = await source.text().catch(() => '');
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
