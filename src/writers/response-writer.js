'use strict';

const { instance: config, LogMode } = require('../configuration');
const { RequestStore } = require('../request-store');
const { RoutePatternFinder } = require('../commands/route-pattern-finder');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');
const { applyMasking } = require('../masking');

/**
 * Sends response payloads to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::ResponseWriter`.
 */
const ResponseWriter = {
  /**
   * @param {number} status - HTTP status code.
   * @param {object} headers - Response headers map.
   * @param {string|null} body - Response body (will be truncated).
   * @param {object} [data={}] - Additional data.
   * @returns {Promise<void>}
   */
  async write(status, headers = {}, body = null, data = {}) {
    try {
      const req = RequestStore.get();
      const route = req ? RoutePatternFinder.find(req) : null;
      const rawPayload = {
        app_name: config.appName,
        env: config.environment,
        // This read
        //
        //   RequestStore.getUuid() || reqHeaders['x-request-id']
        //     || (req && req.id) || null
        //
        // and the two middle terms could never fire: `req` is
        // `RequestStore.get()`, which returns a request only inside
        // `RequestStore.run`, and `run` mints a uuid for every context it opens
        // (`request-store.js:30`), so `getUuid()` is truthy exactly when `req`
        // is defined. They are gone; `getUuid()` already answers null on its
        // own outside a request, so this is the same expression with the dead
        // branches cut out. Same removal as `ExceptionWriter`, same reason.
        //
        // What is deliberately NOT the same is the ending. `ExceptionWriter`
        // and `RequestWriter` now mint an id when they have none, because
        // `application_errors` and `application_requests` both require `uuid`
        // and a null there is a refused row. `application_responses` requires
        // only `[:status, :target_application_environment_id]`
        // (`intake/lib/intake/interactions/application_response.ex:44`), so a
        // null here is stored, not refused — and minting would not buy the row
        // anything, because every read path pairs a response to its request
        // through this exact value
        // (`PrivApplicationRequestController.load_responses_by_uuid/1`,
        // `EndpointFlowController`). A fresh id joins to nothing just as a null
        // does, while looking like a correlation that exists. So this keeps the
        // null rather than fabricating one. See sc-353.
        //
        // In practice this writer runs from `reportInteraction`'s `finish`
        // listener, inside the store context, and sends the request's own uuid;
        // the null case is a caller driving `ResponseWriter.write` by hand.
        uuid: RequestStore.getUuid(),
        status,
        headers,
        body: _truncate(body),
        sent_at: new Date().toISOString(),
        route,
        method: req ? req.method : null,
        data,
        source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
      };
      const payload = applyMasking(rawPayload, 'response', config.maskingRules, config.maskHook);
      await _writer().write([payload]);
    } catch (err) {
      console.error('[EndPointBlank] ResponseWriter failed:', err.message);
    }
  },
};

function _writer() {
  return config.logMode === LogMode.DELAYED
    ? new DelayedWriter('responsesUrl')
    : new DirectWriter('responsesUrl');
}

function _truncate(body) {
  if (body == null) return null;
  return body.length > 1024 ? body.slice(0, 1024) + '...' : body;
}

module.exports = { ResponseWriter };
