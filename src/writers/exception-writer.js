'use strict';

const { randomUUID } = require('crypto');
const { instance: config } = require('../configuration');
const { RequestStore } = require('../request-store');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');
const { LogMode } = require('../configuration');
const { applyMasking } = require('../masking');

/**
 * Sends unhandled application exception payloads to the EndPointBlank API.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Writers::ExceptionWriter`.
 */
const ExceptionWriter = {
  /**
   * @param {Error} err
   * @returns {Promise<void>}
   */
  async write(err) {
    try {
      const req = RequestStore.get();
      const stamped = req
        ? { stamped_path: req.path || req.originalUrl, stamped_http_method: req.method }
        : {};
      const rawPayload = {
        app_name: config.appName,
        message: err.message,
        stacktrace: err.stack ? err.stack.split('\n').slice(1).map(l => l.trim()).filter(Boolean) : null,
        sent_at: new Date().toISOString(),
        source_application_environment_id: RequestStore.getSourceApplicationEnvironmentId(),
        // Intake's `ApplicationError` changeset ends
        // `validate_required([:message, :uuid, :app_name, :sent_at])`
        // (`intake/lib/intake/errors/application_error.ex:46`), so a null
        // `uuid` does not make a sparser row — it makes no row. This read
        //
        //   RequestStore.getUuid()
        //     || (req && req.headers && req.headers['x-request-id'])
        //     || (req && req.id)
        //     || null
        //
        // and resolved to null for every error raised outside a request:
        // background jobs, workers, startup failures. Those are the crashes an
        // operator most wants to hear about, and they were the only ones intake
        // threw away. Since sc-310 that answers 422 rather than 201, so it is
        // at least diagnosable rather than silent. See sc-353.
        //
        // The two middle fallbacks went with it because they could never fire.
        // `req` here is `RequestStore.get()`, which returns a request only
        // inside `RequestStore.run`, and `run` mints a uuid for every context
        // it opens (`request-store.js:30`). `getUuid()` is therefore truthy
        // exactly when `req` is defined, and the chain never reached its second
        // term. `RequestWriter` keeps the equivalent fallbacks precisely
        // because its `req` arrives as an argument and can predate any store
        // context; nothing that reaches this line can.
        //
        // Minting matches what `PayloadBuilder` does for this same row
        // (sc-341), from the same source `RequestStore` mints from, so it is
        // that scheme reaching one step further rather than a second one. An id
        // that correlates with nothing still records the error; no id records
        // nothing.
        uuid: RequestStore.getUuid() || randomUUID(),
        ...stamped,
      };
      const payload = applyMasking(rawPayload, 'error', config.maskingRules, config.maskHook);
      await _writer().write([payload]);
    } catch (reportingErr) {
      console.error('[EndPointBlank] ExceptionWriter failed:', reportingErr.message);
    }
  },
};

function _writer() {
  return config.logMode === LogMode.DELAYED
    ? new DelayedWriter('applicationErrorsUrl')
    : new DirectWriter('applicationErrorsUrl');
}

module.exports = { ExceptionWriter };
