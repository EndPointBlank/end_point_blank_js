'use strict';

/**
 * Thrown when a request fails authentication or authorization.
 *
 * This error is intentionally not logged by the middleware,
 * as unauthorized access attempts are expected to occur.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::UnauthorizedError`.
 */
class UnauthorizedError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = 'UnauthorizedError';
    this.statusCode = statusCode;
  }
}

module.exports = { UnauthorizedError };
