'use strict';

/**
 * Attaches API version metadata to an Express route handler function.
 *
 * Used by {@link registerExpressEndpoints} when publishing endpoint information
 * to the EndPointBlank API.
 *
 * Lifecycle state (Current, Deprecated, …) is **not** declared here. It is
 * managed in the EndPointBlank portal, where changing it does not require
 * shipping code. This reports which versions an endpoint serves, and nothing
 * about what they mean.
 *
 * **Usage:**
 * ```js
 * const { versioned } = require('end-point-blank-js/express');
 *
 * router.get('/api/users', versioned(['v1', 'v2']), listUsers);
 *
 * // Or attach metadata to a handler directly:
 * function listUsers(req, res) { ... }
 * versioned(['v1', 'v2'])(listUsers);
 *
 * // Declaring no specific version is meaningful, and different from not
 * // calling versioned() at all — the endpoint is still reported, with no
 * // version attached.
 * router.get('/health', versioned([]), health);
 * ```
 *
 * @param {string[]} versions - API versions served (e.g. `['v1', 'v2']`).
 * @returns {Function} A pass-through middleware that tags the next handler.
 */
function versioned(versions) {
  /**
   * This middleware is a no-op at runtime — it just carries metadata.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  function versionedMiddleware(req, res, next) {
    next();
  }

  // Deduplicated with declaration order preserved, so the manifest stays stable
  // between deploys instead of churning.
  versionedMiddleware._epbVersions = [...new Set(versions)];

  return versionedMiddleware;
}

/**
 * Reads version metadata attached to an Express handler by {@link versioned}.
 *
 * Returns `undefined` when the handler was never tagged, which is deliberately
 * distinct from `[]` — an endpoint declared with no specific version is still a
 * declared endpoint and is reported (the portal records it with no version).
 * Only undeclared endpoints are skipped.
 *
 * @param {Function} handler
 * @returns {string[]|undefined} Versions served, or undefined if undeclared.
 */
function getVersions(handler) {
  return handler?._epbVersions;
}

module.exports = { versioned, getVersions };
