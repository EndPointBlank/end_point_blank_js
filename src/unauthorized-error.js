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
  constructor(message) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

module.exports = { UnauthorizedError };
