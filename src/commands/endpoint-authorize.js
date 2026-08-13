'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');
const { instance: authCache } = require('./authentication-cache');
const { RequestStore } = require('../request-store');
const { resolveHostname } = require('../base-url');

// The cache declines to store falsy values, so "authorized, not deprecated"
// needs a truthy marker of its own — otherwise every such request would miss
// the cache and re-authorize.
const NO_DEPRECATION = Object.freeze({ none: true });

/**
 * Authorizes an incoming request by sending its details to the EndPointBlank
 * authorize API.
 *
 * Successful results are cached keyed on (client_auth, path, method, appName).
 * Cache hits skip the network call and return a synthetic 201 response.
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
    const clientAuth = req.headers?.authorization ?? '';
    const method = req.method;
    // The version is part of the key because authorization is decided per
    // endpoint version, and so is the deprecation carried back with it. Without
    // it, two callers on different versions of the same route share one entry.
    const cacheKey = `epb_auth:${clientAuth}:${path}:${method}:${config.appName}:${version}`;

    if (authCache.exists(cacheKey)) {
      // The cached value is the deprecation block (or null), not a truthy
      // marker. Authorization is cached per client+route, so caching a marker
      // would limit the Deprecation and Sunset headers to cache misses —
      // roughly one request in N, which reads as a flaky feature rather than a
      // missing one.
      const cached = authCache.retrieve(cacheKey);
      RequestStore.setDeprecation(cached === NO_DEPRECATION ? null : (cached ?? null));
      return { status: 201, ok: true };
    }

    const host = resolveHostname(req);

    const body = {
      path,
      http_method: method,
      client_auth: clientAuth,
      target_hostname: host,
      application: config.appName,
      endpoint_version: version,
      source_ip: remoteAddr(req),
    };

    // Basic, not Bearer. This call is to intake, which already holds this
    // service's credential -- minting a token to present it back was a hop
    // that bought nothing. With no Bearer there is no stale token, so the
    // 401 retry that used to live here is gone: a 401 now means the
    // credential is wrong, which is worth surfacing rather than retrying.
    const authHeader = await Authorization.header();
    const response = await post(config.authorizeUrl, authHeader, body);

    if (!response) return null;

    console.info(`[EndPointBlank] Authorization response: ${response.status}`);
    if (response.status === 201) {
      // Read the body once, here. The success path did not previously touch it,
      // and `response` is a fetch Response whose body can only be consumed once
      // — so parsing it later in the middleware would leave the caller with a
      // drained stream.
      const deprecation = await deprecationFrom(response);
      RequestStore.setDeprecation(deprecation);
      authCache.store(cacheKey, deprecation ?? NO_DEPRECATION);
    } else if (response.status > 299) {
      // Clone before reading, for the same reason the 201 path does: a fetch
      // Response body can only be consumed once, and `authorized.js` reads this
      // one afterwards to build the error the caller sees. Draining it here
      // meant every failure — access_denied, missing_target_endpoint,
      // invalid_credentials — reached the caller as "Authorization service
      // unavailable", which is both wrong and the least useful thing to page on.
      const source = typeof response.clone === 'function' ? response.clone() : response;
      const text = await source.text().catch(() => '');
      console.error(`[EndPointBlank] Authorization failed: ${response.status} - ${text}`);
    }
    return response;
  },
};

/**
 * The authorize response carries a `deprecation` block only when the version
 * being called is deprecated. Absent, malformed, or unparseable all mean the
 * same thing here: nothing to say.
 *
 * Clones the response before reading so the caller's body stays consumable —
 * `authorized.js` reads it on the failure path.
 *
 * @param {Response} response
 * @returns {Promise<object|null>}
 */
async function deprecationFrom(response) {
  try {
    const source = typeof response.clone === 'function' ? response.clone() : response;
    const body = await source.json();
    return body?.deprecation ?? null;
  } catch {
    return null;
  }
}

function remoteAddr(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

module.exports = { EndpointAuthorize };
