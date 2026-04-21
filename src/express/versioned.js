'use strict';

/**
 * Attaches API version metadata to an Express route handler function.
 *
 * Used by {@link registerExpressEndpoints} when publishing endpoint information
 * to the EndPointBlank API.
 *
 * Equivalent to the `version` DSL in the Ruby gem's
 * `EndPointBlank::Rails::Versioned` concern.
 *
 * **Usage:**
 * ```js
 * const { versioned } = require('end-point-blank-js/express');
 *
 * router.get('/api/users', versioned(['v1', 'v2'], { state: 'Current' }), listUsers);
 *
 * // Or attach metadata to a handler directly:
 * function listUsers(req, res) { ... }
 * versioned(['v1', 'v2'], { state: 'Current' })(listUsers);
 * ```
 *
 * @param {string[]} versions - API versions supported (e.g. `['v1', 'v2']`).
 * @param {object} [opts]
 * @param {string} [opts.state='__default__'] - Lifecycle state label.
 * @returns {Function} A pass-through middleware that tags the next handler.
 */
function versioned(versions, { state = '__default__' } = {}) {
  /**
   * This middleware is a no-op at runtime — it just attaches metadata to the
   * next handler in the chain via a side-effect-free wrapper.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  function versionedMiddleware(req, res, next) {
    next();
  }

  versionedMiddleware._epbVersions = versionedMiddleware._epbVersions || {};
  versionedMiddleware._epbVersions[state] = versions;

  return versionedMiddleware;
}

/**
 * Reads version metadata attached to an Express handler by {@link versioned}.
 *
 * @param {Function} handler
 * @returns {object} Map of state → versions array.
 */
function getVersions(handler) {
  return handler?._epbVersions ?? {};
}

module.exports = { versioned, getVersions };
