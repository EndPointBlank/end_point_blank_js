'use strict';

const { randomUUID } = require('crypto');
const { instance: config, LogMode } = require('../configuration');
const { RequestStore } = require('../request-store');
const { VersionFinder } = require('../commands/version-finder');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');
const { applyMasking } = require('../masking');
const { resolveBaseUrl } = require('../base-url');

/**
 * Sends request payloads to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::RequestWriter`.
 */
const RequestWriter = {
  /**
   * @param {import('express').Request} req
   * @returns {Promise<void>}
   */
  async write(req) {
    try {
      if (!req) return;
      const version = VersionFinder.find(req);
      const headers = req.headers ? { ...req.headers } : {};
      const rawPayload = {
        app_name: config.appName,
        env: config.environment,
        // `uuid` is required on this stream too —
        // `intake/lib/intake/interactions/application_request.ex:77-84`, where
        // the comment above the list calls it "the correlation key" — so the
        // `|| null` this used to end in did not produce an uncorrelated request
        // row, it produced no request row at all. That changeset feeds
        // `Intake.BulkInsert.insert_all/3`, where an invalid changeset is
        // dropped rather than degraded, so the whole observation went. See
        // sc-353.
        //
        // The two middle fallbacks stay, unlike the ones removed from
        // `ExceptionWriter` and `ResponseWriter`: those two read `req` from
        // `RequestStore.get()`, which is non-empty only inside
        // `RequestStore.run` — and `run` always mints — so their chains were
        // dead past the first term. Here `req` is this function's own argument.
        // A caller can hand one over with no store context around it (the
        // module is public API via `./src/*`), and then an inbound
        // `X-Request-Id` is a better correlation key than a fresh id, because
        // the caller's other services are already using it. The tests under
        // "correlating the record" cover all four terms.
        uuid: RequestStore.getUuid() || headers['x-request-id'] || req.id || randomUUID(),
        headers,
        path: req.path || req.url || null,
        http_method: req.method || null,
        endpoint_version: version,
        request: _readBody(req),
        sent_at: new Date().toISOString(),
        ...resolveBaseUrl(req, { trustProxyHeaders: config.trustProxyHeaders }),
      };
      const payload = applyMasking(rawPayload, 'request', config.maskingRules, config.maskHook);
      await _writer().write([payload]);
    } catch (err) {
      console.error('[EndPointBlank] RequestWriter failed:', err.message);
    }
  },
};

function _writer() {
  return config.logMode === LogMode.DELAYED
    ? new DelayedWriter('requestsUrl')
    : new DirectWriter('requestsUrl');
}

function _readBody(req) {
  try {
    if (req.body === undefined || req.body === null) return null;
    if (typeof req.body === 'string') return req.body;
    return JSON.stringify(req.body);
  } catch (_err) {
    return null;
  }
}

module.exports = { RequestWriter };
