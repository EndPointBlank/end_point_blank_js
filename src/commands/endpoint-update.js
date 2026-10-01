'use strict';

const os = require('os');
const { instance: config } = require('../configuration');
const { Authorization } = require('../authorization');
const { post } = require('./_http');
const { VERSION } = require('../version');
const log = require('../log');

/**
 * Sends application endpoint registration information to the EndPointBlank API.
 *
 * Callers supply the endpoint list since JavaScript has no universal route
 * introspection. For Express apps use {@link registerExpressEndpoints}.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::EndpointUpdate`.
 */
class EndpointUpdate {
  /**
   * @param {Array<object>} [endpoints] - List of endpoint descriptor objects,
   *   each with `path`, `action`, and optionally `versions` keys.
   */
  constructor(endpoints = []) {
    this.endpoints = endpoints;
  }

  /** Sends the endpoint registration payload to the API. */
  async update() {
    await this._write(this._applicationInfo());
  }

  /**
   * Convenience static method.
   *
   * @param {Array<object>} [endpoints]
   * @returns {Promise<void>}
   */
  static async sendUpdate(endpoints = []) {
    await new EndpointUpdate(endpoints).update();
  }

  /**
   * Never rejects. `registerExpressEndpoints` is called from an
   * `app.listen` callback with nothing to catch it, so a rejection here would
   * be unhandled and end a boot that otherwise succeeded. A missing
   * `clientId`/`clientSecret` (`ConfigurationError`, sc-1469), an unusable
   * intake URL, or a non-network error from `post()` is logged with its name,
   * as the writers log theirs, and the update is skipped.
   */
  async _write(data) {
    log.info(
      `[EndPointBlank] Sending application update: ` +
        `application=${data.application} environment=${data.environment} ` +
        `app_version=${data.app_version}`
    );

    try {
      const authHeader = Authorization.intakeHeader();
      const response = await post(config.endpointUpdateUrl, authHeader, data);
      if (!response) return;
      if (response.status > 299) {
        const body = await response.text();
        console.error(`[EndPointBlank] Failed to update endpoints: ${response.status} - ${body}`);
      } else {
        log.info(`[EndPointBlank] Endpoints updated successfully: ${response.status}`);
      }
    } catch (err) {
      console.error(`[EndPointBlank] Failed to update endpoints: ${err.name}: ${err.message}`);
    }
  }

  _applicationInfo() {
    return {
      application: config.appName,
      hostname: os.hostname(),
      lib_version: VERSION,
      environment: config.environment,
      endpoints: this.endpoints,
      app_version: config.applicationVersion,
    };
  }
}

module.exports = { EndpointUpdate };
