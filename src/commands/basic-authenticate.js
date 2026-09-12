'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');
const log = require('../log');
const { RequestStore } = require('../request-store');

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
    // The key names are intake's, not this SDK's choice. `POST /authorize`
    // reads `client_auth`, `path`, `http_method`, `endpoint_version` and
    // `source_ip`, and ignores every other key in the body — so a misspelling
    // here is not a rename, it is a field that was never sent.
    //
    // `http_method` is the one that is fatal: every clause of intake's
    // `AuthorizeAccess.authorize/1` pattern-matches it, so a body without it
    // falls through to `def authorize(_params), do: {:error, :invalid_params}`
    // and the controller answers 401. This command sent `action`, so no
    // credential it could ever present was going to be accepted.
    //
    // `endpoint_version` and `source_ip` failed quietly instead: intake
    // recorded both columns as nil on every authenticate row, and the
    // deprecation lookup — which is keyed on `endpoint_version` — could never
    // find a version to report on.
    //
    // `endpoint-authorize.js` has always spelled all three correctly, which is
    // why the authorize path works and this one never has.
    const body = {
      path,
      http_method: method,
      client_auth: clientAuth,
      application: config.appName,
      endpoint_version: version,
      source_ip: ipAddress ?? remoteAddr(req),
    };

    const response = await post(config.authorizeUrl, authHeader, body);
    if (!response) return null;

    log.info(`[EndPointBlank] Authentication response: ${response.status}`);
    if (response.status === 201) {
      const sourceApplicationEnvironmentId = await sourceEnvironmentIdFrom(response);
      RequestStore.setSourceApplicationEnvironmentId(sourceApplicationEnvironmentId);
    }
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

async function sourceEnvironmentIdFrom(response) {
  let body = null;
  try {
    const source = typeof response.clone === 'function' ? response.clone() : response;
    body = await source.json();
  } catch (err) {
    console.error(
      '[EndPointBlank] Authenticated, but the authorize response has no ' +
        'data[0].source_application_environment_id, so this request\'s responses, ' +
        `logs and errors will not name their caller: ${err.message}`,
    );
    return null;
  }

  const id = body?.data?.[0]?.source_application_environment_id;
  if (typeof id === 'string' && id !== '') return id;

  console.error(
    '[EndPointBlank] Authenticated, but the authorize response has no ' +
      'data[0].source_application_environment_id, so this request\'s responses, ' +
      `logs and errors will not name their caller: body=${JSON.stringify(body)}`,
  );
  return null;
}

function remoteAddr(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

module.exports = { BasicAuthenticate };
