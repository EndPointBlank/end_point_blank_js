'use strict';

const { BasicAuthenticate } = require('../commands/basic-authenticate');
const { VersionFinder } = require('../commands/version-finder');
const { UnauthorizedError } = require('../unauthorized-error');

/**
 * Express route middleware that enforces EndPointBlank authentication before
 * the next handler is called.
 *
 * If the remote authentication service does not return HTTP 201 an
 * `UnauthorizedError` is passed to `next(err)`.
 *
 * Equivalent to the `before_action :authenticate!` set up by the Ruby gem's
 * `EndPointBlank::Rails::Authenticated` concern.
 *
 * **Usage:**
 * ```js
 * const { authenticated } = require('end-point-blank-js/express');
 *
 * // Applied to a single route
 * router.get('/protected', authenticated, (req, res) => res.json({ ok: true }));
 *
 * // Applied to all routes on a router
 * router.use(authenticated);
 * ```
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticated(req, res, next) {
  try {
    const path = req.route?.path || req.path || req.url;
    const version = VersionFinder.find(req);

    const response = await BasicAuthenticate.authenticate(req, path, version);

    if (!response || response.status !== 201) {
      let message = 'Authentication service unavailable';
      if (response) {
        const body = await response.json().catch(() => ({}));
        message = body.error || (await response.text().catch(() => message));
      }
      return next(new UnauthorizedError(`Authentication failed: ${message}`));
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticated };
