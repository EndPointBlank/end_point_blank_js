'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');

/**
 * Generates an access token by calling the EndPointBlank API.
 *
 * Sends the hostname (and optional TTL) to the configured `accessTokenUrl`
 * and returns the parsed JSON response containing `token` and `expired_at`.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::GenerateAccessToken`.
 */
const GenerateAccessToken = {
  /**
   * Requests a new access token for *hostname*.
   *
   * @param {string} hostname
   * @returns {Promise<object|null>} Object with `token` and `expired_at`, or `null` on failure.
   */
  async token(hostname) {
    const body = { hostname };
    if (config.tokenTtl != null) {
      body.token_ttl = config.tokenTtl;
    }

    const authHeader = await Authorization.header();
    const response = await post(config.accessTokenUrl, authHeader, body);
    if (!response) return null;

    try {
      const data = await response.json();
      console.info(`[EndPointBlank] Access token response: ${response.status}`);
      return data;
    } catch (err) {
      console.error(`[EndPointBlank] Failed to parse access token response: ${err.message}`);
      return null;
    }
  },
};

module.exports = { GenerateAccessToken };
