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
 * - `baseUrl` — the URL the token was requested for, exactly as passed. The
 *   message names only its scheme, host and path (see `describeUrl`), so a
 *   userinfo or query secret in it stays off `err.message` and out of logs.
 * - `outcome` — one of `TokenOutcome` (`credential_rejected`,
 *   `request_rejected`, `server_error`, `transport_error`), or `null` when the
 *   mint threw before producing an outcome (the original error is `cause`;
 *   its message is deliberately not copied into this one).
 * - `status` — intake's HTTP status, or `null` when none was obtained.
 */
class TokenUnavailableError extends Error {
  /**
   * @param {string} baseUrl
   * @param {{outcome?: string|null, status?: number|null, cause?: Error}} [details]
   */
  constructor(baseUrl, { outcome = null, status = null, cause } = {}) {
    super(
      `Could not mint an EndPointBlank access token for ${describeUrl(baseUrl)}: ` +
        `${reason(outcome, status, cause)}. ` +
        'EndPointBlank never sends this service\'s client_id/client_secret ' +
        'to a provider, so there is no Basic-auth fallback and the call must ' +
        'not be made without a token.',
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'TokenUnavailableError';
    this.baseUrl = baseUrl;
    this.outcome = outcome;
    this.status = status;
  }
}

/**
 * The URL as the message may show it: scheme, host and path only. Userinfo,
 * query and fragment are dropped because the caller controls `baseUrl` and
 * any of them can carry a secret, and `err.message` is what ends up in logs
 * and error reporting. The raw value stays on `err.baseUrl`.
 */
function describeUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'the requested URL (not shown: it could not be parsed)';
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
      // Deliberately a fixed phrase: the cause's own message is not copied in
      // (it is not ours to vouch for and may carry anything). It stays
      // available, unaltered, on `err.cause`.
      if (cause !== undefined) return 'the token request failed unexpectedly';
      return 'the token request failed for an unknown reason';
  }
}

module.exports = { TokenUnavailableError };
