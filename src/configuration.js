'use strict';

/**
 * LogMode enum - controls whether payloads are sent synchronously or queued.
 */
const LogMode = Object.freeze({
  DIRECT: 'direct',
  DELAYED: 'delayed',
});

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
   */
  get baseUrl() {
    return this._baseUrl || process.env.ENDPOINTBLANK_BASE_URL || 'https://in.endpointblank.com';
  }

  set baseUrl(value) {
    this._baseUrl = value;
  }

  /**
   * Returns the configured log base URL, falling back to the
   * ENDPOINTBLANK_LOG_BASE_URL environment variable, then a built-in default.
   */
  get logBaseUrl() {
    return this._logBaseUrl || process.env.ENDPOINTBLANK_LOG_BASE_URL || 'https://log.endpointblank.com';
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

  get endpointErrorUrl() {
    return `${this.baseUrl}/api/endpoint_errors`;
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

module.exports = { Configuration, LogMode, instance };
