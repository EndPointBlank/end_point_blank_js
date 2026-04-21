'use strict';

const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('../commands/_http');

const URL_RESOLVERS = {
  applicationErrorsUrl: () => config.applicationErrorsUrl,
  endpointErrorUrl: () => config.endpointErrorUrl,
  logUrl: () => config.logUrl,
  requestsUrl: () => config.requestsUrl,
  responsesUrl: () => config.responsesUrl,
};

/**
 * Synchronously POSTs a list of payloads to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::DirectWriter`.
 */
class DirectWriter {
  /**
   * @param {string} urlKey - One of `'applicationErrorsUrl'`, `'endpointErrorUrl'`, `'logUrl'`.
   */
  constructor(urlKey) {
    const resolver = URL_RESOLVERS[urlKey] ?? URL_RESOLVERS.applicationErrorsUrl;
    this._url = resolver();
  }

  /**
   * Sends *payloads* to the configured API endpoint.
   *
   * @param {object[]} payloads
   * @returns {Promise<void>}
   */
  async write(payloads) {
    const authHeader = await Authorization.header();
    const response = await post(this._url, authHeader, { payload: payloads });
    if (response && response.status > 299) {
      console.warn(`[EndPointBlank] Write failed: ${response.status}`);
    }
  }
}

module.exports = { DirectWriter };
