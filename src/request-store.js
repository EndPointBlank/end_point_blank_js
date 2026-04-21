'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

/**
 * Async-context-local store for the current request object and associated
 * per-request data (such as `sourceApplicationEnvironmentId`).
 *
 * Uses Node.js `AsyncLocalStorage` so the stored request is automatically
 * scoped to the current async call chain — the JavaScript equivalent of
 * Ruby's thread-local `Thread.current['rack-env']`.
 *
 * Set by {@link module:middleware/report-interaction} on every request.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Rack::EnvStore`.
 */
const storage = new AsyncLocalStorage();

const RequestStore = {
  /**
   * Runs `fn` with `request` available via `RequestStore.get()` throughout
   * the async call chain initiated by `fn`.
   *
   * @param {object} request - The request object (Express `req` or Node `IncomingMessage`).
   * @param {Function} fn - Async function to run within the request context.
   * @returns {Promise<*>}
   */
  run(request, fn) {
    return storage.run({ request, sourceEnvId: null, uuid: randomUUID() }, fn);
  },

  /**
   * Returns the request stored for the current async context, or `undefined`.
   *
   * @returns {object|undefined}
   */
  get() {
    const ctx = storage.getStore();
    return ctx ? ctx.request : undefined;
  },

  /**
   * Stores the source application environment ID for the current async context.
   *
   * @param {string|null} id
   */
  setSourceApplicationEnvironmentId(id) {
    const ctx = storage.getStore();
    if (ctx) ctx.sourceEnvId = id;
  },

  /**
   * Returns the source application environment ID for the current async context.
   *
   * @returns {string|null}
   */
  getSourceApplicationEnvironmentId() {
    const ctx = storage.getStore();
    return ctx ? ctx.sourceEnvId : null;
  },

  /**
   * Returns the UUID generated for the current request context.
   *
   * @returns {string|null}
   */
  getUuid() {
    const ctx = storage.getStore();
    return ctx ? ctx.uuid : null;
  },
};

module.exports = { RequestStore };
