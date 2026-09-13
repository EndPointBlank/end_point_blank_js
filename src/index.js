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

const { instance: config, LogMode, ConfigurationError } = require('./configuration');
const { UnauthorizedError } = require('./unauthorized-error');
const { VERSION } = require('./version');
const { TokenOutcome } = require('./commands/generate-access-token');

const CONFIGURE_KEYS = Object.freeze([
  'clientId', 'clientSecret', 'baseUrl', 'logBaseUrl', 'environment', 'appName',
  'workerCount', 'logMode', 'versionFinder', 'applicationVersion',
  'tokenTtl', 'cacheTtl', 'trustProxyHeaders', 'maskingRules', 'maskHook',
]);

/**
 * Configure the EndPointBlank library.
 *
 * All properties are optional; only supplied values are updated.
 *
 * Throws {@link ConfigurationError} if `opts` contains any key not in
 * `CONFIGURE_KEYS`, and applies nothing in that case. A typo such as
 * `clientSecert` or `baseUri` would otherwise leave the app running with no
 * credentials, or pointed at the production default, with nothing to say so.
 *
 * @throws {ConfigurationError} if any key in `opts` is unknown

 * @param {object} opts
 * @param {string} [opts.clientId]
 * @param {string} [opts.clientSecret]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.logBaseUrl]
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
  // Checked in full before anything is assigned, so a bad call changes nothing.
  const unknown = Object.keys(opts).filter((key) => !CONFIGURE_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `configure() received unknown key(s): ${unknown.join(', ')}. ` +
      `Valid keys are: ${CONFIGURE_KEYS.join(', ')}. No configuration was applied.`
    );
  }
  for (const key of CONFIGURE_KEYS) {
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
  // Thrown from a baseUrl/logBaseUrl getter on first read if the configured
  // value can never produce a working URL. Re-exported here, next to
  // UnauthorizedError, so a caller catching this breaking-change throw does
  // not have to reach into src/configuration -- the path this package's
  // public surface otherwise refuses to make people take.
  ConfigurationError,
  // How a token request came back, for callers that branch on it. Surfaced
  // here for the same reason LogMode is: it is a constant a consumer has to
  // compare against, and making them reach into src/commands/ for it invites
  // the retyped string literal it exists to prevent.
  TokenOutcome,
  // Expose config singleton for direct access when needed
  config,
};
