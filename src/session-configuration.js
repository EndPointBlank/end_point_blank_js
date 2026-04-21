'use strict';

const { instance: config } = require('./configuration');

/**
 * Provides session-level configuration derived from the current environment.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::SessionConfiguration`.
 */
const SessionConfiguration = {
  /**
   * Returns the environment name.
   *
   * Resolution order:
   * 1. `config.environment` if set
   * 2. `NODE_ENV` environment variable
   * 3. `'production'` as fallback
   *
   * @returns {string}
   */
  envName() {
    if (config.environment) return config.environment;
    return process.env.NODE_ENV || 'production';
  },
};

module.exports = { SessionConfiguration };
