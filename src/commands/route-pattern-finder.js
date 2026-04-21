'use strict';

/**
 * Extracts the matched route pattern from an Express request.
 *
 * Returns `req.route.path` (e.g. `"/users/:id"`) when available, or `null`
 * when the request has not been matched to a route (e.g. 404s).
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::RoutePatternFinder`.
 */
const RoutePatternFinder = {
  /**
   * @param {import('express').Request} req
   * @returns {string|null}
   */
  find(req) {
    try {
      return (req && req.route && req.route.path) ? req.route.path : null;
    } catch (_err) {
      return null;
    }
  },
};

module.exports = { RoutePatternFinder };
