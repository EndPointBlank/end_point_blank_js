'use strict';

const { EndpointAuthorize } = require('../commands/endpoint-authorize');
const { VersionFinder } = require('../commands/version-finder');
const { UnauthorizedError } = require('../unauthorized-error');

/**
 * Express route middleware that enforces EndPointBlank authorization before
 * the next handler is called.
 *
 * If the remote authorization service does not return HTTP 201 an
 * `UnauthorizedError` is passed to `next(err)`.
 *
 * Equivalent to the `before_action :authorize!` set up by the Ruby gem's
 * `EndPointBlank::Rails::Authorized` concern.
 *
 * **Usage:**
 * ```js
 * const { authorized } = require('end-point-blank-js/express');
 *
 * router.get('/sensitive', authorized, (req, res) => res.json({ ok: true }));
 * router.use(authorized); // protect all routes
 * ```
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authorized(req, res, next) {
  try {
    const path = req.baseUrl + (req.route?.path || req.path || req.url);
    const version = VersionFinder.find(req);

    const response = await EndpointAuthorize.authorize(req, path, version);

    if (!response || response.status !== 201) {
      let message = 'Authorization service unavailable';
      if (response) {
        const body = await response.json().catch(() => ({}));
        message = body.error || (await response.text().catch(() => message));
      }
      return next(new UnauthorizedError(`Authorization failed: ${message}`));
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authorized };
