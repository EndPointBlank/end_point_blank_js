'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

/**
 * Async-context-local store for the current request object and associated
 * per-request data (such as `sourceApplicationEnvironmentId` and
 * `sourceOrganizationId`).
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
    // A fresh context every time, never the one already in force: a request
    // that arrives inside another's async chain (a reused worker, a nested
    // `run`) must not lend that request's caller to this one.
    return storage.run(
      { request, sourceEnvId: null, sourceOrganizationId: null, deprecation: null, uuid: randomUUID() },
      fn,
    );
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
   * Set by `EndpointAuthorize` from intake's grant, on a cache hit as well as a
   * miss, and read by the response, log and error writers.
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
   * Stores the calling organization's EndPointBlank id for the current async
   * context, from intake's `/authorize` answer
   * (`data[0].source_organization_id`, sc-1571).
   *
   * Set by `EndpointAuthorize` beside the source application environment id,
   * on a cache hit as well as a miss.
   *
   * @param {string|null} id
   */
  setSourceOrganizationId(id) {
    const ctx = storage.getStore();
    if (ctx) ctx.sourceOrganizationId = id;
  },

  /**
   * Returns the calling organization's EndPointBlank id for the current async
   * context. `null` when intake is older than that field, the organization
   * has no id there, or the request was not authorized.
   *
   * @returns {string|null}
   */
  getSourceOrganizationId() {
    const ctx = storage.getStore();
    return ctx ? ctx.sourceOrganizationId : null;
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
