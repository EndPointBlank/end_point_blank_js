'use strict';

/**
 * LogMode enum - controls whether payloads are sent synchronously or queued.
 */
const LogMode = Object.freeze({
  DIRECT: 'direct',
  DELAYED: 'delayed',
});

/**
 * Thrown when a configured value can never produce a working URL.
 *
 * Raised eagerly, at the point the value is read, rather than left to fail
 * silently later: every write built from a misconfigured `baseUrl` or
 * `logBaseUrl` would otherwise 404, and `DirectWriter` only warning-logs a
 * failed write, so nothing would ever surface the mistake to an operator.
 */
class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// Every endpoint URL in this file is built by appending `API_SUFFIX/<resource>`
// to `baseUrl` or `logBaseUrl` (see the getters below, e.g. `authorizeUrl`).
// A configured value that already ends in `API_SUFFIX` would double up into
// `/api/api/<resource>` and 404 on every request -- see `normalizeBaseUrl`.
const API_SUFFIX = '/api';

/**
 * Normalizes a configured base URL at the point it is read.
 *
 * Strips any number of trailing slashes unconditionally -- a trailing slash
 * is the single most common way to mistype a base URL, it is unambiguous to
 * fix, and this project's convention is to fix an unambiguous typo rather
 * than force every integrator to get it byte-exact.
 *
 * Then, if the (now slash-stripped) value already ends in `API_SUFFIX`,
 * raises: that is not a typo normalization can correct, it is a base URL
 * that can never produce a working endpoint URL, so it is better caught here
 * at configure time than left to fail silently on every request forever.
 *
 * @param {string} url the raw configured value (already defaulted)
 * @param {string} propertyName `'baseUrl'` or `'logBaseUrl'`, for the message
 * @returns {string} the normalized base URL
 */
function normalizeBaseUrl(url, propertyName) {
  const stripped = url.replace(/\/+$/, '');
  if (stripped.endsWith(API_SUFFIX)) {
    throw new ConfigurationError(
      `${propertyName} '${url}' already ends in '${API_SUFFIX}'. Endpoint URLs are built by ` +
      `appending '${API_SUFFIX}/<resource>' to ${propertyName}, so this would request ` +
      `'${stripped}${API_SUFFIX}/<resource>' and 404 on every call. Set ${propertyName} to ` +
      `the origin only (e.g. 'https://in.endpointblank.com'), without the '${API_SUFFIX}' suffix.`
    );
  }
  return stripped;
}

/**
 * Singleton configuration for the EndPointBlank library.
 *
 * Configure via {@link configure}:
 * ```js
 * const epb = require('end-point-blank-js');
 * epb.configure({
 *   clientId: 'your-client-id',
 *   clientSecret: 'your-client-secret',
 *   appName: 'my-app',
 *   environment: 'production',
 * });
 * ```
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Configuration`.
 */
class Configuration {
  constructor() {
    this._reset();
  }

  _reset() {
    this._clientId = null;
    this._clientSecret = null;
    this._baseUrl = null;
    this._logBaseUrl = null;
    this._environment = null;
    this._appName = null;
    this.workerCount = 4;
    this.logMode = LogMode.DIRECT;
    this.versionFinder = null;
    this.applicationVersion = null;
    this.tokenTtl = null;       // seconds
    this.cacheTtl = 300;        // seconds
    this.trustProxyHeaders = true;
    this.maskingRules = [];
    this.maskHook = null;
  }

  /**
   * Returns the configured client id, falling back to the
   * ENDPOINTBLANK_CLIENT_ID environment variable when not explicitly set.
   */
  get clientId() {
    return this._clientId || process.env.ENDPOINTBLANK_CLIENT_ID || null;
  }

  set clientId(value) {
    this._clientId = value;
  }

  /**
   * Returns the configured client secret, falling back to the
   * ENDPOINTBLANK_CLIENT_SECRET environment variable when not explicitly set.
   */
  get clientSecret() {
    return this._clientSecret || process.env.ENDPOINTBLANK_CLIENT_SECRET || null;
  }

  set clientSecret(value) {
    this._clientSecret = value;
  }

  /**
   * Returns the configured base URL, falling back to the
   * ENDPOINTBLANK_BASE_URL environment variable, then a built-in default.
   *
   * The resolved value is normalized: trailing slashes are stripped, and a
   * value that already ends in `/api` raises {@link ConfigurationError} (see
   * `normalizeBaseUrl` above).
   */
  get baseUrl() {
    const raw = this._baseUrl || process.env.ENDPOINTBLANK_BASE_URL || 'https://in.endpointblank.com';
    return normalizeBaseUrl(raw, 'baseUrl');
  }

  set baseUrl(value) {
    this._baseUrl = value;
  }

  /**
   * Returns the configured log base URL, falling back to the
   * ENDPOINTBLANK_LOG_BASE_URL environment variable, then a built-in default.
   *
   * Normalized the same way as {@link Configuration#baseUrl}: trailing
   * slashes stripped, `/api`-suffixed values raise {@link ConfigurationError}.
   */
  get logBaseUrl() {
    const raw = this._logBaseUrl || process.env.ENDPOINTBLANK_LOG_BASE_URL || 'https://log.endpointblank.com';
    return normalizeBaseUrl(raw, 'logBaseUrl');
  }

  set logBaseUrl(value) {
    this._logBaseUrl = value;
  }

  /**
   * Returns the configured application name, falling back to the
   * ENDPOINTBLANK_APP_NAME environment variable when not explicitly set.
   */
  get appName() {
    return this._appName || process.env.ENDPOINTBLANK_APP_NAME || null;
  }

  set appName(value) {
    this._appName = value;
  }

  /**
   * Returns the configured environment name, falling back to the
   * ENDPOINTBLANK_ENV environment variable when not explicitly set.
   */
  get environment() {
    return this._environment || process.env.ENDPOINTBLANK_ENV || null;
  }

  set environment(value) {
    this._environment = value;
  }

  get logUrl() {
    return `${this.logBaseUrl}/api/application_logs`;
  }

  get endpointUpdateUrl() {
    return `${this.baseUrl}/api/application_updates`;
  }

  get accessTokenUrl() {
    return `${this.baseUrl}/api/access_token`;
  }

  get authorizeUrl() {
    return `${this.baseUrl}/api/authorize`;
  }

  get applicationErrorsUrl() {
    return `${this.logBaseUrl}/api/application_errors`;
  }

  get requestsUrl() {
    return `${this.logBaseUrl}/api/application_requests`;
  }

  get responsesUrl() {
    return `${this.logBaseUrl}/api/application_responses`;
  }
}

const instance = new Configuration();

module.exports = { Configuration, LogMode, ConfigurationError, instance };
