'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');
const log = require('../log');

/**
 * What a token request came back as.
 *
 * The status intake answers with carries a decision the caller has to make,
 * and collapsing them all to "no token" throws that away:
 *
 * - `CREDENTIAL_REJECTED` (401) — the client credential is invalid or
 *   revoked. Permanent until the credential itself is re-issued; retrying
 *   the same request can only produce another 401. intake deliberately uses
 *   401 rather than 422 for this, precisely so it can be told apart.
 * - `REQUEST_REJECTED` (any other 4xx) — intake understood the request and
 *   refused it: a malformed `token_ttl`, a missing `base_url` (400), or no
 *   target/source application for the URL (422). Permanent too, but the
 *   remedy is the request or the registration, not the credential — so it
 *   must not share a name that reads as "transient".
 * - `SERVER_ERROR` (5xx, or any other non-2xx status) — intake failed.
 *   Trying again later is reasonable.
 * - `TRANSPORT_ERROR` — no usable HTTP status was obtained at all: connection
 *   refused, timeout, `post()`'s own retries exhausted. Also transient.
 * - `SUCCESS` (2xx) — a payload came back. It still has to carry a `token`
 *   and a `base_url` to be usable; that judgement belongs to the caller.
 *
 * The status decides, and a body that will not parse never overrides it: a
 * proxy in front of intake can answer 401 with an HTML page, and that
 * credential is being refused just as surely as one refused in JSON. The sole
 * exception is a 2xx the SDK cannot read, which is a broken server.
 *
 * Frozen so callers branch on a shared symbol rather than a bare string
 * literal they have retyped.
 */
const TokenOutcome = Object.freeze({
  SUCCESS: 'success',
  CREDENTIAL_REJECTED: 'credential_rejected',
  REQUEST_REJECTED: 'request_rejected',
  SERVER_ERROR: 'server_error',
  TRANSPORT_ERROR: 'transport_error',
});

/**
 * @typedef {object} TokenResult
 * @property {string} outcome one of {@link TokenOutcome}.
 * @property {number|null} status the HTTP status, or `null` when the request
 *   never landed. Always carried, so a caller can be more precise than the
 *   outcome name when it needs to be.
 * @property {object|null} payload the parsed response body, or `null` when
 *   there was none to parse.
 */

/** @returns {TokenResult} */
function result(outcome, status, payload) {
  return Object.freeze({ outcome, status, payload });
}

/**
 * Generates an access token by calling the EndPointBlank API.
 *
 * Sends the base URL (and optional TTL) to the configured `accessTokenUrl`
 * and returns the parsed JSON response containing `token`, `expired_at` and
 * `base_url`.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::GenerateAccessToken`.
 */
const GenerateAccessToken = {
  /**
   * Requests a new access token for *baseUrl*, reporting how it went.
   *
   * The status-carrying entry point. {@link GenerateAccessToken.token} is the
   * older payload-or-`null` form and stays exactly as it was; this is the one
   * to call when the caller needs to know whether trying again could help.
   *
   * @param {string} baseUrl sent verbatim. intake normalizes it and matches
   *   it against registered base URLs by longest path prefix.
   * @returns {Promise<TokenResult>} never `null`, and never throws for a
   *   response it could not read.
   */
  async tokenResult(baseUrl) {
    const body = { base_url: baseUrl };
    if (config.tokenTtl != null) {
      body.token_ttl = config.tokenTtl;
    }

    const authHeader = await Authorization.header();
    const response = await post(config.accessTokenUrl, authHeader, body);

    // TRANSPORT_ERROR means one thing and only one thing: no usable HTTP
    // status was obtained. `post()` has already exhausted its own retries by
    // the time it answers null, so nothing landed. A `fetch` Response always
    // carries a status, so one answering without a status cannot be
    // classified either -- and guessing a bucket for it would be the collapse
    // this function exists to undo.
    if (!response) return result(TokenOutcome.TRANSPORT_ERROR, null, null);
    const status = response.status != null ? response.status : null;
    if (status === null) return result(TokenOutcome.TRANSPORT_ERROR, null, null);

    // Classify on the status, then read the body -- never the other way
    // round. A parse failure must not override a status the SDK did receive.
    // The SDK reaches intake through Caddy, and anything in front of the app
    // -- a reverse proxy, a WAF, an ALB, an auth gateway -- can answer 401
    // with an HTML error page intake never generated. The credential really
    // is being refused there; classifying on parseability would tell the
    // caller "transient, keep retrying" about a request that can never
    // succeed. An unreadable body only costs the payload, which is null.
    let data = null;
    let readable = true;
    try {
      data = await response.json();
    } catch (err) {
      readable = false;
      console.error(`[EndPointBlank] Failed to parse access token response: ${err.message}`);
    }

    if (readable) log.info(`[EndPointBlank] Access token response: ${response.status}`);

    if (status >= 200 && status < 300) {
      // The one place a parse failure decides the outcome: the status said
      // yes and there is nothing to act on, which is the same broken server
      // as a 201 carrying no token.
      return readable
        ? result(TokenOutcome.SUCCESS, status, data)
        : result(TokenOutcome.SERVER_ERROR, status, null);
    }
    if (status === 401) return result(TokenOutcome.CREDENTIAL_REJECTED, status, data);
    if (status >= 400 && status < 500) return result(TokenOutcome.REQUEST_REJECTED, status, data);
    return result(TokenOutcome.SERVER_ERROR, status, data);
  },

  /**
   * Requests a new access token for *baseUrl*.
   *
   * Unchanged: the parsed body, whatever the status was, or `null` when there
   * was no body to parse. A caller that needs to tell a rejected credential
   * from a failing service wants {@link GenerateAccessToken.tokenResult}
   * instead; this stays as it is so published consumers keep working.
   *
   * @param {string} baseUrl sent verbatim. intake normalizes it and matches
   *   it against registered base URLs by longest path prefix.
   * @returns {Promise<object|null>} Object with `token`, `expired_at` and
   *   `base_url`, or `null` on failure.
   */
  async token(baseUrl) {
    return (await GenerateAccessToken.tokenResult(baseUrl)).payload;
  },
};

module.exports = { GenerateAccessToken, TokenOutcome };
