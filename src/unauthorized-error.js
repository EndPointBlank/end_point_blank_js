'use strict';

/**
 * Thrown when a request fails authentication or authorization.
 *
 * This error is intentionally not logged by the middleware,
 * as unauthorized access attempts are expected to occur.
 *
 * `statusCode` carries the status intake answered the authenticate or
 * authorize call with, so a handler can tell the two refusals apart: 401 means
 * the credential was not accepted and the integrator should check it, 403
 * means the credential was fine but no grant covers this endpoint and the
 * integrator should ask for one. Collapsing both to 401 sends them to debug
 * the wrong thing.
 *
 * It defaults to 401 so that `new UnauthorizedError(message)` keeps working
 * unchanged, and because 401 is the safe reading of a refusal that arrives
 * with no status attached. The guards never lean on that default: they pass
 * intake's status, or 503 when intake did not answer at all.
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

/**
 * Build the `UnauthorizedError` for a non-201 answer to intake's authenticate
 * or authorize call. `action` is `'Authentication'` or `'Authorization'`.
 *
 * One function rather than a copy per guard. `authenticated` and `authorized`
 * were two transcriptions of one decision, and two copies is how one of them
 * acquires a fix the other does not. That is not hypothetical here: it is
 * exactly what happened to both halves of this function. `authorized` passed
 * intake's status and read the body once; `authenticated` dropped the status
 * and read the body twice, so a non-JSON error body from a proxy lost its text
 * as well. Both are fixed here, once.
 *
 * @param {Response|null|undefined} response
 * @param {'Authentication'|'Authorization'} action
 * @returns {Promise<UnauthorizedError>}
 */
async function refusalFrom(response, action) {
  if (!response) {
    // Intake never answered at all, so nothing refused this caller and 401
    // would blame a credential that was never judged. 503 says the true
    // thing — the check could not be made — and is what the other SDKs
    // already send for this same case: Java, Ruby's `result&.status || 503`,
    // and Elixir's literal `send_resp(503, ...)`. It is also the one case the
    // "service unavailable" message is actually true for.
    return new UnauthorizedError(`${action} failed: ${action} service unavailable`, 503);
  }

  // Only a fallback from here down: intake did answer, so this stands in for a
  // body that could not be read rather than for an outage.
  let message = `${action} service unavailable`;

  // Read the body exactly once. Calling json() and then text() on the same
  // Response can only ever fail on the second read: whichever ran first
  // consumed the stream. Take the text, then try to parse it, and fall back
  // to the raw text for a non-JSON error.
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

  // Intake's verdict verbatim. 401 tells an integrator to check the
  // credential, 403 tells them to ask for a grant.
  return new UnauthorizedError(`${action} failed: ${message}`, response.status);
}

module.exports = { UnauthorizedError, refusalFrom };
