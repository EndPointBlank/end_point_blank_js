'use strict';

const { stripUrl } = require('./strip-url');

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
 * - `baseUrl` — the URL the token was requested for, stripped to scheme,
 *   host, port and path (see `stripUrl`), or `null` when it could not be
 *   parsed. Userinfo, query and fragment can carry a secret, and error
 *   reporters capture an error's own fields as well as its message, so they
 *   are not kept anywhere on the error; the caller already has the URL it
 *   passed.
 * - `outcome` — one of `TokenOutcome` (`credential_rejected`,
 *   `request_rejected`, `server_error`, `transport_error`). A mint that threw
 *   is `transport_error`, with the original error as `cause`; its message is
 *   deliberately not copied into this one. `null` only when no result was
 *   recorded.
 * - `status` — intake's HTTP status, or `null` when none was obtained.
 */
class TokenUnavailableError extends Error {
  /**
   * @param {string} baseUrl
   * @param {{outcome?: string|null, status?: number|null, cause?: Error}} [details]
   */
  constructor(baseUrl, { outcome = null, status = null, cause } = {}) {
    const stripped = stripUrl(baseUrl);
    super(
      `Could not mint an EndPointBlank access token for ${describeUrl(stripped)}: ` +
        `${reason(outcome, status, cause)}. ` +
        'EndPointBlank never sends this service\'s client_id/client_secret ' +
        'to a provider, so there is no Basic-auth fallback and the call must ' +
        'not be made without a token.',
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'TokenUnavailableError';
    this.baseUrl = stripped;
    this.outcome = outcome;
    this.status = status;
  }
}

/** The stripped URL, or a fixed phrase when there is none to show. */
function describeUrl(stripped) {
  return stripped !== null ? stripped : 'the requested URL (not shown: it could not be parsed)';
}

function reason(outcome, status, cause) {
  // Deliberately a fixed phrase: the cause's own message is not copied in (it
  // is not ours to vouch for and may carry anything). It stays available,
  // unaltered, on `err.cause`. Checked before the outcome because a mint that
  // threw is also reported as `transport_error`.
  if (cause !== undefined) return 'the token request failed unexpectedly';

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
      return 'the token request failed for an unknown reason';
  }
}

module.exports = { TokenUnavailableError };
