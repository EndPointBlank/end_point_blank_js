'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');
const { instance: authCache } = require('./authentication-cache');
const { RequestStore } = require('../request-store');
const { resolveHostname } = require('../base-url');
const log = require('../log');

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

    // A hit replays everything the grant said about this call: the caller's
    // source environment and the deprecation block, either of which may be
    // null. Authorization is cached per client+route, so anything a hit left
    // out would reach cache misses only — roughly one request in N. That is how
    // the Deprecation and Sunset headers once read as a flaky feature, and the
    // source environment would have gone the same way had only misses recorded
    // it (sc-473).
    //
    // The entry is always an object, so the cache (which declines falsy values)
    // always stores it, and one `retrieve` both finds and reads it — there is
    // no separate `exists` check for an expiry to land between.
    const cached = authCache.retrieve(cacheKey);
    if (cached) {
      RequestStore.setSourceApplicationEnvironmentId(cached.sourceApplicationEnvironmentId);
      RequestStore.setDeprecation(cached.deprecation);
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
      uuid: RequestStore.getUuid(),
    };

    // Basic, not Bearer. This call is to intake, which already holds this
    // service's credential -- minting a token to present it back was a hop
    // that bought nothing. With no Bearer there is no stale token, so the
    // 401 retry that used to live here is gone: a 401 now means the
    // credential is wrong, which is worth surfacing rather than retrying.
    const authHeader = await Authorization.header();
    const response = await post(config.authorizeUrl, authHeader, body);

    if (!response) return null;

    log.info(`[EndPointBlank] Authorization response: ${response.status}`);
    if (response.status === 201) {
      // Read the body once, here. The success path did not previously touch it,
      // and `response` is a fetch Response whose body can only be consumed once
      // — so parsing it later in the middleware would leave the caller with a
      // drained stream.
      const grant = await grantFrom(response);
      RequestStore.setSourceApplicationEnvironmentId(grant.sourceApplicationEnvironmentId);
      RequestStore.setDeprecation(grant.deprecation);
      authCache.store(cacheKey, grant);
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
 * What intake's 201 says about this call.
 *
 * Intake renders the grant under `data` (`AuthorizationJSON.show/1`): one
 * entry naming the caller's `source_application_environment_id`. The
 * response, log and error writers attach that id, intake stores it on each
 * row, and app_portal's error page maps it to the "Client" that made the call.
 * This used to read only `deprecation`, so the id was null on every request
 * and that row read "—" for every error this SDK reported (sc-473). Rails
 * reads the same key, `data[0].source_application_environment_id`.
 *
 * A 201 without the id still authorizes. Intake refuses (401) any caller whose
 * credential has no application environment, so a missing id means the
 * response contract moved — and refusing would turn lost attribution into an
 * outage of legitimate traffic. But it is logged, once per cache miss, rather
 * than recorded as null in silence.
 *
 * The `deprecation` block is present only when the version being called is
 * deprecated. Absent, malformed, or unparseable all mean the same thing for
 * it: nothing to say.
 *
 * Clones the response before reading so the caller's body stays consumable —
 * `authorized.js` reads it on the failure path.
 *
 * @param {Response} response
 * @returns {Promise<{sourceApplicationEnvironmentId: string|null, deprecation: object|null}>}
 */
async function grantFrom(response) {
  let body = null;
  let unreadable = null;
  try {
    const source = typeof response.clone === 'function' ? response.clone() : response;
    body = await source.json();
  } catch (err) {
    unreadable = err;
  }

  const id = body?.data?.[0]?.source_application_environment_id;
  const sourceApplicationEnvironmentId = typeof id === 'string' && id !== '' ? id : null;

  if (sourceApplicationEnvironmentId === null) {
    const seen = unreadable ? `an unreadable body (${unreadable.message})` : `body=${JSON.stringify(body)}`;
    console.error(
      '[EndPointBlank] Authorized, but the authorize response has no ' +
        'data[0].source_application_environment_id, so the responses, logs and errors ' +
        `this request writes will not name their caller: ${seen}`,
    );
  }

  return { sourceApplicationEnvironmentId, deprecation: body?.deprecation ?? null };
}

function remoteAddr(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

module.exports = { EndpointAuthorize };
