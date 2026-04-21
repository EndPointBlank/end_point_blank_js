'use strict';

const { instance: config } = require('./configuration');

/**
 * Generates HTTP authorization headers for EndPointBlank API calls.
 *
 * If a valid Bearer token is cached for the given hostname it returns a
 * `Bearer <token>` header; otherwise falls back to HTTP Basic auth using
 * the configured `clientId` and `clientSecret`.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Authorization`.
 */
const Authorization = {
  /**
   * Returns a formatted authorization header value.
   *
   * @param {string|null} [hostname] - If provided and a valid token is cached,
   *   returns a Bearer token header.
   * @returns {Promise<string>} `"Bearer <token>"` or `"Basic <credentials>"`
   */
  async header(hostname = null) {
    if (hostname) {
      const { AccessTokens } = require('./tokens/access-tokens');
      const token = await AccessTokens.token(hostname);
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
