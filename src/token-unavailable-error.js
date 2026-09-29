'use strict';

/**
 * Thrown by `Authorization.header(baseUrl)` when no access token could be
 * obtained for a call this application is about to make to a provider.
 *
 * There is deliberately no fallback. Until sc-1469 the SDK answered a failed
 * mint with HTTP Basic built from this application's own `clientId` and
 * `clientSecret`, which put the application's credential on the wire to the
 * provider (and so into the provider's intake and logs). A client must never
 * hand its own secret to a provider, so a missing token is now an error the
 * caller has to handle, not a silent downgrade.
 *
 * Carries what the token cache recorded about the failure, so a caller can
 * tell a permanent refusal from a transient outage without parsing the
 * message:
 *
 * - `baseUrl` — the URL the token was requested for.
 * - `outcome` — one of `TokenOutcome` (`credential_rejected`,
 *   `request_rejected`, `server_error`, `transport_error`), or `null` when the
 *   mint threw before producing an outcome (the original error is `cause`).
 * - `status` — intake's HTTP status, or `null` when none was obtained.
 */
class TokenUnavailableError extends Error {
  /**
   * @param {string} baseUrl
   * @param {{outcome?: string|null, status?: number|null, cause?: Error}} [details]
   */
  constructor(baseUrl, { outcome = null, status = null, cause } = {}) {
    super(
      `[EndPointBlank] No access token could be minted for ${baseUrl}: ` +
        `${reason(outcome, status, cause)}. ` +
        'No Authorization header was produced: this application\'s client ' +
        'credentials are never sent to a provider.',
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'TokenUnavailableError';
    this.baseUrl = baseUrl;
    this.outcome = outcome;
    this.status = status;
  }
}

function reason(outcome, status, cause) {
  const http = status != null ? ` (HTTP ${status})` : '';
  switch (outcome) {
    case 'credential_rejected':
      return `intake rejected this application's client credential${http}; ` +
        'retrying cannot help -- re-issue the credential';
    case 'request_rejected':
      return `intake refused the token request${http}; check the URL and ` +
        'that a grant covers the target';
    case 'server_error':
      return `intake failed to issue a token${http}; this may be transient`;
    case 'transport_error':
      return 'intake could not be reached (timeout, connection refused or ' +
        'retries exhausted); this may be transient';
    default:
      if (cause && cause.message) return `the token request failed: ${cause.message}`;
      return 'the token request failed for an unknown reason';
  }
}

module.exports = { TokenUnavailableError };
