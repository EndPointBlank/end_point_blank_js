'use strict';

const { ConfigurationError } = require('../configuration');
const { Transport } = require('./transport');
const {
  OrganizationResource,
  ApiPackagesResource,
  EndpointsResource,
  ClientsResource,
  ApplicationsResource,
  EnvironmentsResource,
  CredentialsResource,
  ManagedClientScope,
} = require('./resources');

const DEFAULT_BASE_URL = 'https://app.endpointblank.com';
const KEY_PREFIX = 'epb_mk_';
const KEY_FORMAT = /^epb_mk_[A-Za-z0-9_-]+$/;
// Hosts a plain-http baseUrl may name: the key would otherwise cross the
// network in cleartext.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const OPTION_KEYS = Object.freeze([
  'apiKey', 'baseUrl', 'maxRetries', 'maxRetryWaitMs', 'retryBaseDelayMs', 'timeoutMs',
  'fetch', 'sleep',
]);

const DEFAULTS = Object.freeze({
  maxRetries: 2,
  maxRetryWaitMs: 60_000,
  retryBaseDelayMs: 500,
  timeoutMs: 30_000,
});

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A client for the EndPointBlank management API (`/api/v1`): the calls an
 * organization admin makes in the portal, made from code with a management
 * API key (`epb_mk_...`, created in the portal under Settings > API Keys).
 *
 * Entirely separate from the runtime client that `configure()` sets up. It
 * reads none of that configuration and no `ENDPOINTBLANK_*` variable, sends
 * the management key only as `Authorization: Bearer` and only to `baseUrl`,
 * and never sends a runtime `clientId`/`clientSecret`.
 *
 * ```js
 * const { ManagementClient } = require('end-point-blank-js/management');
 * const mgmt = new ManagementClient({ apiKey: process.env.EPB_MGMT_KEY });
 * const org = await mgmt.organization.get();
 * ```
 *
 * The key is held in a private field: it does not appear in `util.inspect`,
 * `JSON.stringify`, `String(client)` or any error this client throws.
 */
class ManagementClient {
  #transport;

  /**
   * @param {object} options
   * @param {string} options.apiKey - a management API key, `epb_mk_...`
   * @param {string} [options.baseUrl] - default `https://app.endpointblank.com`
   * @param {number|false} [options.maxRetries] - retries after the first
   *   attempt (default 2); `0` or `false` turns retrying off
   * @param {number} [options.maxRetryWaitMs] - the longest `Retry-After` wait
   *   honoured (default 60000); a longer one is thrown instead
   * @param {number} [options.retryBaseDelayMs] - backoff for retries with no
   *   `Retry-After`: this, then twice this, ... (default 500)
   * @param {number} [options.timeoutMs] - per attempt (default 30000)
   * @param {Function} [options.fetch] - a `fetch` to use instead of the global
   * @param {Function} [options.sleep] - `(ms) => Promise`, to wait between
   *   retries (tests pass one that does not wait)
   * @throws {ConfigurationError} for an unknown option, a missing or
   *   malformed key, or an unusable `baseUrl`
   */
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new ConfigurationError('ManagementClient takes an options object: new ManagementClient({ apiKey }).');
    }
    const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
    if (unknown.length > 0) {
      throw new ConfigurationError(
        `ManagementClient received unknown option(s): ${unknown.join(', ')}. ` +
          `Valid options are: ${OPTION_KEYS.join(', ')}.`
      );
    }

    const settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (options[key] !== undefined) settings[key] = options[key];
    }
    if (settings.maxRetries === false) settings.maxRetries = 0;
    checkNonNegativeInteger('maxRetries', settings.maxRetries);
    checkNonNegativeInteger('maxRetryWaitMs', settings.maxRetryWaitMs);
    checkNonNegativeInteger('retryBaseDelayMs', settings.retryBaseDelayMs);
    checkNonNegativeInteger('timeoutMs', settings.timeoutMs);
    if (settings.timeoutMs === 0) {
      throw new ConfigurationError('ManagementClient option timeoutMs must be at least 1.');
    }
    for (const key of ['fetch', 'sleep']) {
      if (options[key] !== undefined && typeof options[key] !== 'function') {
        throw new ConfigurationError(`ManagementClient option ${key} must be a function.`);
      }
    }

    this.#transport = new Transport({
      apiKey: checkApiKey(options.apiKey),
      baseUrl: checkBaseUrl(options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl),
      fetch: options.fetch,
      sleep: options.sleep,
      ...settings,
    });

    const transport = this.#transport;
    /** `GET /organization`. */
    this.organization = new OrganizationResource(transport);
    /** `/api_packages` and `/api_packages/:id/endpoints`. */
    this.apiPackages = new ApiPackagesResource(transport);
    /** `GET /endpoints`: find the ids package endpoints and grants take. */
    this.endpoints = new EndpointsResource(transport);
    /** `/clients`, with `.packages` and `.grants`. */
    this.clients = new ClientsResource(transport);
    /** `/applications`, with `.environments`. */
    this.applications = new ApplicationsResource(transport);
    /** `/environments`. */
    this.environments = new EnvironmentsResource(transport);
    /** `/credentials`: runtime client credentials. */
    this.credentials = new CredentialsResource(transport);
  }

  /** The base URL calls go to, without `/api/v1`. */
  get baseUrl() {
    return this.#transport.baseUrl;
  }

  /**
   * The same applications, environments and credentials calls, made for one
   * of your managed clients (`/clients/:client_id/...`), plus `claimInvite`.
   *
   * @param {string} clientId - the client's `id` from `clients.create` or `clients.list`
   * @returns {ManagedClientScope}
   */
  forManagedClient(clientId) {
    return new ManagedClientScope(this.#transport, clientId);
  }

  toString() {
    return `ManagementClient(${this.baseUrl})`;
  }

  toJSON() {
    return { baseUrl: this.baseUrl, apiKey: `${KEY_PREFIX}[REDACTED]` };
  }

  [INSPECT]() {
    return `ManagementClient { baseUrl: '${this.baseUrl}', apiKey: '${KEY_PREFIX}[REDACTED]' }`;
  }
}

function checkApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ConfigurationError(
      'ManagementClient needs apiKey: a management API key (epb_mk_...) from the portal\'s ' +
        'Settings > API Keys. Runtime client credentials are not accepted by the management API.'
    );
  }
  // The value is never echoed: a mixed-up runtime secret would otherwise end
  // up in whatever logs the exception.
  // app_portal mints `epb_mk_` + URL-safe base64 without padding. Anything
  // else could not be a key, and a character a header cannot carry (NUL, a
  // newline) would make `fetch` throw an error quoting the whole header.
  if (!KEY_FORMAT.test(apiKey)) {
    throw new ConfigurationError(
      'ManagementClient apiKey is not a management API key: it must start with ' +
        `"${KEY_PREFIX}". Runtime client credentials (client_id/client_secret) are not ` +
        'accepted by the management API.'
    );
  }
  return apiKey;
}

function checkBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigurationError('ManagementClient baseUrl must be an absolute http or https URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigurationError('ManagementClient baseUrl must be an absolute http or https URL.');
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigurationError(
      'ManagementClient baseUrl must be https: the management key would be sent in cleartext. ' +
        'Plain http is allowed only for localhost, 127.0.0.1 and [::1].'
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(
      'ManagementClient baseUrl must not carry credentials, a query or a fragment.'
    );
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/api(\/v1)?$/.test(path)) {
    throw new ConfigurationError(
      'ManagementClient baseUrl must not end in /api or /api/v1: the client adds /api/v1 itself. ' +
        `Use ${url.origin}${path.replace(/\/api(\/v1)?$/, '')} instead.`
    );
  }
  return url.origin + path;
}

function checkNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(`ManagementClient option ${name} must be a non-negative integer.`);
  }
}

module.exports = { ManagementClient, DEFAULT_BASE_URL };
