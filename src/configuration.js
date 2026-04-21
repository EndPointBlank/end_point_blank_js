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
    this.clientId = null;
    this.clientSecret = null;
    this.baseUrl = 'https://in.endpointblank.com';
    this.logBaseUrl = 'https://log.endpointblank.com';
    this.environment = null;
    this.appName = null;
    this.workerCount = 4;
    this.logMode = LogMode.DIRECT;
    this.versionFinder = null;
    this.applicationVersion = null;
    this.tokenTtl = null;       // seconds
    this.cacheTtl = 300;        // seconds
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
