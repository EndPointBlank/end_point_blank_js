'use strict';

const { EndpointAuthorize } = require('../commands/endpoint-authorize');
const { VersionFinder } = require('../commands/version-finder');
const { UnauthorizedError } = require('../unauthorized-error');
const { RequestStore } = require('../request-store');
const { DeprecationHeaders } = require('../deprecation-headers');
const { requestPath } = require('./request-path');

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
    const path = requestPath(req);
    const version = VersionFinder.find(req);

    const response = await EndpointAuthorize.authorize(req, path, version);

    if (!response || response.status !== 201) {
      const statusCode = response ? response.status : 503;
      // No response at all means the authorize service could not be reached —
      // the one case the generic message is actually true for.
      let message = 'Authorization service unavailable';
      if (response) {
        // Read the body exactly once. The previous form called json() and then
        // text() on the same Response, so the second read could only ever fail:
        // whichever ran first consumed the stream. Take the text, then try to
        // parse it, and fall back to the raw text for a non-JSON error.
        const text = await response.text().catch(() => '');
        if (text) {
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          message = parsed?.error || text;
        }
      }
      return next(new UnauthorizedError(`Authorization failed: ${message}`, statusCode));
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
