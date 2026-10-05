'use strict';

/**
 * Every `error.code` the EndPointBlank management API is documented to answer,
 * plus the few this SDK reports itself (`network_error`, `http_error`,
 * `invalid_response`).
 *
 * Match on these rather than on retyped string literals:
 *
 * ```js
 * if (err.code === ErrorCode.PLAN_LIMIT) { ... }
 * ```
 *
 * The list is not closed. app_portal can add a code before this SDK knows it,
 * and an unknown code still arrives on {@link ManagementApiError#code} as the
 * server sent it; nothing here refuses or rewrites it.
 *
 * Mirrors app_portal's `AppPortalWeb.ManagementApi.ErrorCodes`.
 */
const ErrorCode = Object.freeze({
  // Authentication and limits
  MISSING_KEY: 'missing_key', // 401
  INVALID_KEY: 'invalid_key', // 401
  RUNTIME_CREDENTIAL_REFUSED: 'runtime_credential_refused', // 401
  INSUFFICIENT_SCOPE: 'insufficient_scope', // 403: the key is read-only
  AUDIT_UNAVAILABLE: 'audit_unavailable', // 503: retryable
  RATE_LIMITED: 'rate_limited', // 429: wait Retry-After seconds
  PLAN_LIMIT: 'plan_limit', // 402

  // Requests
  VALIDATION_FAILED: 'validation_failed', // 422: details lists fields
  NOT_FOUND: 'not_found', // 404: no such resource, or no such /api/v1 path
  INVALID_PAGINATION: 'invalid_pagination', // 400
  INVALID_FILTER: 'invalid_filter', // 422
  INVALID_IDEMPOTENCY_KEY: 'invalid_idempotency_key', // 400
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused', // 422
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'idempotency_request_in_progress', // 409: retryable
  IDEMPOTENCY_REPLAY_UNAVAILABLE: 'idempotency_replay_unavailable', // 409: never retried
  BAD_REQUEST: 'bad_request', // 400: the request could not be read (e.g. invalid JSON)
  INTERNAL_SERVER_ERROR: 'internal_server_error', // 500

  // Applications, environments and API packages
  HAS_DEPENDENTS: 'has_dependents', // 422
  PROTECTED: 'protected', // 422
  INVALID_ENVIRONMENT_BASE_URLS: 'invalid_environment_base_urls', // 422
  API_PACKAGE_ASSIGNED: 'api_package_assigned', // 422
  INTAKE_SYNC_FAILED: 'intake_sync_failed', // 422

  // Credentials
  DELETE_REFUSED: 'delete_refused', // 422: retry the DELETE
  INTAKE_CREDENTIAL: 'intake_credential', // 409
  INTAKE_REJECTED: 'intake_rejected', // 422
  INTAKE_UNAVAILABLE: 'intake_unavailable', // 503: retryable

  // Clients, packages and grants
  INVALID_CONTACTS: 'invalid_contacts',
  INVALID_PACKAGES: 'invalid_packages',
  INVALID_GRANTS: 'invalid_grants',
  INVALID_MANAGED: 'invalid_managed',
  CLIENT_NOT_ACCEPTED: 'client_not_accepted',
  CLIENT_ACCEPTED: 'client_accepted',
  CLIENT_NOT_MANAGED: 'client_not_managed',
  RETURN_TO_NOT_REGISTERED: 'return_to_not_registered', // 422: return_to is not a registered claim return URL
  ALREADY_A_MEMBER: 'already_a_member',
  MANAGED_CLIENT_HAS_CREDENTIALS: 'managed_client_has_credentials',
  API_PACKAGE_NOT_FOUND: 'api_package_not_found',
  ENVIRONMENT_NOT_FOUND: 'environment_not_found',
  ALREADY_ASSIGNED: 'already_assigned',
  NOTHING_PUBLISHED_IN_ENVIRONMENT: 'nothing_published_in_environment',
  APPLICATION_NOT_FOUND: 'application_not_found',
  ENDPOINT_NOT_FOUND: 'endpoint_not_found',
  ENVIRONMENT_NOT_IN_APPLICATION: 'environment_not_in_application',
  ALREADY_GRANTED: 'already_granted',
  GRANT_REVOKED_CONCURRENTLY: 'grant_revoked_concurrently', // 409

  // Reported by this SDK, never by the server
  NETWORK_ERROR: 'network_error', // the request never completed (status null)
  HTTP_ERROR: 'http_error', // an error answer with no {"error": {...}} JSON body
  INVALID_RESPONSE: 'invalid_response', // a success answer that is not a JSON object
});

/**
 * An error answer from the management API, or a request that never got one.
 *
 * - `code` — the API's `error.code` (see {@link ErrorCode}), passed through
 *   unchanged even when this SDK does not know it.
 * - `message` — the API's `error.message`, for people. It may change; match
 *   on `code`.
 * - `details` — the API's `error.details` (field errors for
 *   `validation_failed`, `published_in` for `nothing_published_in_environment`),
 *   or `null`.
 * - `status` — the HTTP status, or `null` when no answer arrived.
 * - `retryAfter` — the `Retry-After` header in seconds, or `null`.
 * - `method`, `path` — the request, path only (`/api/v1/...`), never a host,
 *   query string or header.
 * - `idempotencyKey` — the `Idempotency-Key` the request carried, or `null`.
 * - `location` — the answer's `location` header, or `null`. On
 *   `idempotency_replay_unavailable` it names the resource the first request
 *   created.
 * - `requestId` — app_portal's `x-request-id`, for support, or `null`.
 *
 * Nothing on it ever holds the management key or a credential secret.
 */
class ManagementApiError extends Error {
  constructor({
    code,
    message,
    details = null,
    status = null,
    retryAfter = null,
    method = null,
    path = null,
    idempotencyKey = null,
    location = null,
    requestId = null,
    cause,
  }) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'ManagementApiError';
    this.code = code;
    this.details = details;
    this.status = status;
    this.retryAfter = retryAfter;
    this.method = method;
    this.path = path;
    this.idempotencyKey = idempotencyKey;
    this.location = location;
    this.requestId = requestId;
  }
}

module.exports = { ErrorCode, ManagementApiError };
