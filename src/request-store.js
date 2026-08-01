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
    return storage.run({ request, sourceEnvId: null, deprecation: null, uuid: randomUUID() }, fn);
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
   * Stores the authorize response's deprecation block for the current async
   * context, so the response can be given RFC 9745 / RFC 8594 headers.
   *
   * Lives on the per-request context object rather than anywhere module-level:
   * `AsyncLocalStorage` scopes it to this request's async call chain, so a
   * concurrent request cannot read it and nothing has to be cleaned up.
   *
   * @param {object|null} deprecation
   */
  setDeprecation(deprecation) {
    const ctx = storage.getStore();
    if (ctx) ctx.deprecation = deprecation;
  },

  /**
   * Returns the deprecation block for the current async context, or `null`.
   *
   * @returns {object|null}
   */
  getDeprecation() {
    const ctx = storage.getStore();
    return ctx ? ctx.deprecation : null;
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
