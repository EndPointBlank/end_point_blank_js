'use strict';

const { instance: config } = require('../configuration');

/**
 * Generates HTTP Basic Authorization headers using the configured client credentials.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::BearerGenerate`.
 */
const BearerGenerate = {
  /**
   * Returns the Base64-encoded `clientId:clientSecret` string.
   *
   * @returns {string}
   */
  generate() {
    return Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  },

  /**
   * Returns a properly formatted `Basic <credentials>` header value.
   *
   * @returns {string}
   */
  authHeader() {
    return `Basic ${this.generate()}`;
  },
};

module.exports = { BearerGenerate };
