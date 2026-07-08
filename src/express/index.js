'use strict';

/**
 * Aggregated Express integration entry point.
 *
 * ```js
 * const { authenticated, authorized, versioned, registerExpressEndpoints } =
 *   require('end-point-blank-js/express');
 * ```
 */

const { authenticated } = require('./authenticated');
const { authorized } = require('./authorized');
const { versioned, getVersions } = require('./versioned');
const { registerExpressEndpoints, collectEndpoints } = require('./endpoint-registrar');

module.exports = {
  authenticated,
  authorized,
  versioned,
  getVersions,
  registerExpressEndpoints,
  collectEndpoints,
};
