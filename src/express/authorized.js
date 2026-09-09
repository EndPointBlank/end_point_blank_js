'use strict';

const { EndpointAuthorize } = require('../commands/endpoint-authorize');
const { VersionFinder } = require('../commands/version-finder');
const { refusalFrom } = require('../unauthorized-error');
const { RequestStore } = require('../request-store');
const { DeprecationHeaders } = require('../deprecation-headers');
const { requestPath } = require('./request-path');

/**
 * Express route middleware that enforces EndPointBlank authorization before
 * the next handler is called.
 *
 * If the remote authorization service does not return HTTP 201 an
 * `UnauthorizedError` is passed to `next(err)`, carrying that service's own
 * status as `statusCode` — or 503 when it did not answer at all.
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
    const path = requestPath(req);
    const version = VersionFinder.find(req);

    const response = await EndpointAuthorize.authorize(req, path, version);

    if (!response || response.status !== 201) {
      return next(await refusalFrom(response, 'Authorization'));
    }

    // RFC 9745 / RFC 8594. Set here rather than in reportInteraction, because
    // that middleware only sees the response on `finish` — by which point the
    // headers have already gone out. This runs before the route does.
    DeprecationHeaders.apply(res, RequestStore.getDeprecation());

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authorized };
