'use strict';

const { instance: config } = require('../configuration');

const DEPRECATION_MESSAGE =
  'BearerGenerate is deprecated (sc-1469): its header carries this service\'s ' +
  'own client_id/client_secret and is only valid for its own EndPointBlank ' +
  'intake. Never send it to a provider; use Authorization.header(url) for ' +
  'outbound calls.';

let warned = false;

function warnOnce() {
  if (warned) return;
  warned = true;
  process.emitWarning(DEPRECATION_MESSAGE, 'DeprecationWarning');
}

/**
 * Generates HTTP Basic Authorization headers using the configured client credentials.
 *
 * @deprecated The header carries this service's own secret
 *   (`clientId:clientSecret`) and is only valid for this service's own
 *   EndPointBlank intake. Never send it to a provider. For outbound calls use
 *   `Authorization.header(url)`, which answers `Bearer <token>` or throws
 *   (sc-1469).
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::BearerGenerate`.
 */
const BearerGenerate = {
  /**
   * Returns the Base64-encoded `clientId:clientSecret` string.
   *
   * @deprecated See {@link BearerGenerate}: this service's secret, valid only
   *   for its own intake; use `Authorization.header(url)` for providers.
   * @returns {string}
   */
  generate() {
    warnOnce();
    return Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  },

  /**
   * Returns a properly formatted `Basic <credentials>` header value.
   *
   * @deprecated See {@link BearerGenerate}: this service's secret, valid only
   *   for its own intake; use `Authorization.header(url)` for providers.
   * @returns {string}
   */
  authHeader() {
    warnOnce();
    return `Basic ${this.generate()}`;
  },
};

/** Test hook: lets a test observe the one-time warning again. */
function _resetDeprecationWarning() {
  warned = false;
}

module.exports = { BearerGenerate, _resetDeprecationWarning, DEPRECATION_MESSAGE };
