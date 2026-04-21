'use strict';

const { RequestStore } = require('../request-store');
const { UnauthorizedError } = require('../unauthorized-error');
const { RequestWriter } = require('../writers/request-writer');
const { ResponseWriter } = require('../writers/response-writer');
const { ExceptionWriter } = require('../writers/exception-writer');

/**
 * Express/Connect middleware that stores the current request in an
 * `AsyncLocalStorage` context, writes request info to the EndPointBlank API,
 * and writes response info when the response finishes.
 *
 * `UnauthorizedError` is re-thrown without logging, as unauthorized access
 * attempts are expected behavior.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Middleware::Rack::ReportInteraction`.
 *
 * **Express usage:**
 * ```js
 * const { reportInteraction, reportInteractionErrorHandler } = require('end-point-blank-js/middleware');
 * app.use(reportInteraction);
 * app.use(yourRoutes);
 * app.use(reportInteractionErrorHandler);
 * ```
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function reportInteraction(req, res, next) {
  RequestStore.run(req, () => {
    RequestWriter.write(req).catch(err => {
      console.error('[EndPointBlank] RequestWriter error:', err.message);
    });

    res.on('finish', () => {
      const headers = res.getHeaders ? res.getHeaders() : {};
      ResponseWriter.write(res.statusCode, headers, null).catch(err => {
        console.error('[EndPointBlank] ResponseWriter error:', err.message);
      });
    });

    next();
  });
}

/**
 * Express error-handling middleware companion.
 *
 * Register this **after** `reportInteraction` and all your routes so it
 * captures errors passed to `next(err)`:
 *
 * ```js
 * app.use(reportInteraction);
 * app.use(yourRoutes);
 * app.use(reportInteractionErrorHandler);
 * ```
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function reportInteractionErrorHandler(err, req, res, next) {
  if (!(err instanceof UnauthorizedError)) {
    await ExceptionWriter.write(err).catch(reportErr => {
      console.error('[EndPointBlank] Failed to report error:', reportErr.message);
    });
  }
  next(err);
}

module.exports = { reportInteraction, reportInteractionErrorHandler };
