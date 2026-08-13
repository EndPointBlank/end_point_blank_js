'use strict';

const { instance: config } = require('./configuration');

/**
 * Generates HTTP authorization headers for EndPointBlank API calls.
 *
 * If a valid Bearer token can be obtained for the given base URL it returns a
 * `Bearer <token>` header; otherwise falls back to HTTP Basic auth using the
 * configured `clientId` and `clientSecret`.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Authorization`.
 */
const Authorization = {
  /**
   * Returns a formatted authorization header value.
   *
   * @param {string|null} [baseUrl] - The URL you are about to call, with any
   *   query string and fragment removed. If provided, a token covering it is
   *   used (and minted if necessary) and returned as a Bearer header. Called
   *   with no argument this is the Basic form — which is what the calls to
   *   intake itself use, since intake already holds this service's
   *   credential.
   * @returns {Promise<string>} `"Bearer <token>"` or `"Basic <credentials>"`
   */
  async header(baseUrl = null) {
    if (baseUrl) {
      const { AccessTokens } = require('./tokens/access-tokens');
      const token = await AccessTokens.token(baseUrl);
      if (token) return `Bearer ${token}`;
    }
    return `Basic ${this.basicCredentials()}`;
  },

  /**
   * Returns the Base64-encoded `clientId:clientSecret` string.
   *
   * @returns {string}
   */
  basicCredentials() {
    const raw = `${config.clientId}:${config.clientSecret}`;
    return Buffer.from(raw).toString('base64');
  },
};

module.exports = { Authorization };
