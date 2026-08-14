'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');
const log = require('../log');

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
   * Requests a new access token for *baseUrl*.
   *
   * @param {string} baseUrl sent verbatim. intake normalizes it and matches
   *   it against registered base URLs by longest path prefix.
   * @returns {Promise<object|null>} Object with `token`, `expired_at` and
   *   `base_url`, or `null` on failure.
   */
  async token(baseUrl) {
    const body = { base_url: baseUrl };
    if (config.tokenTtl != null) {
      body.token_ttl = config.tokenTtl;
    }

    const authHeader = await Authorization.header();
    const response = await post(config.accessTokenUrl, authHeader, body);
    if (!response) return null;

    try {
      const data = await response.json();
      log.info(`[EndPointBlank] Access token response: ${response.status}`);
      return data;
    } catch (err) {
      console.error(`[EndPointBlank] Failed to parse access token response: ${err.message}`);
      return null;
    }
  },
};

module.exports = { GenerateAccessToken };
