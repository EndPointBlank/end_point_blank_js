'use strict';

/**
 * EndPointBlank JavaScript Library
 * =================================
 *
 * Endpoint tracking, authorization, and error reporting for Node.js web applications.
 *
 * Quick start:
 * ```js
 * const epb = require('end-point-blank-js');
 *
 * epb.configure({
 *   clientId: 'your-client-id',
 *   clientSecret: 'your-client-secret',
 *   appName: 'my-app',
 *   environment: 'production',
 * });
 *
 * // Express middleware
 * const { reportInteraction, reportInteractionErrorHandler } = require('end-point-blank-js/middleware');
 * app.use(reportInteraction);
 * app.use(yourRoutes);
 * app.use(reportInteractionErrorHandler);
 *
 * // Route-level auth middleware
 * const { authenticated, authorized } = require('end-point-blank-js/express');
 * router.get('/protected', authenticated, handler);
 * ```
 */

const { instance: config, LogMode } = require('./configuration');
const { UnauthorizedError } = require('./unauthorized-error');

const VERSION = '0.1.0';

/**
 * Configure the EndPointBlank library.
 *
 * All properties are optional; only supplied values are updated.
 *
 * @param {object} opts
 * @param {string} [opts.clientId]
 * @param {string} [opts.clientSecret]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.environment]
 * @param {string} [opts.appName]
 * @param {number} [opts.workerCount]
 * @param {import('./configuration').LogMode} [opts.logMode]
 * @param {Function} [opts.versionFinder] - `(req) => string|null`
 * @param {string} [opts.applicationVersion]
 * @param {number} [opts.tokenTtl] - Seconds
 * @param {number} [opts.cacheTtl] - Seconds (default: 300)
 */
function configure(opts = {}) {
  const allowed = [
    'clientId', 'clientSecret', 'baseUrl', 'environment', 'appName',
    'workerCount', 'logMode', 'versionFinder', 'applicationVersion',
    'tokenTtl', 'cacheTtl',
  ];
  for (const key of allowed) {
    if (opts[key] !== undefined) {
      config[key] = opts[key];
    }
  }
}

module.exports = {
  configure,
  VERSION,
  LogMode,
  UnauthorizedError,
  // Expose config singleton for direct access when needed
  config,
};
