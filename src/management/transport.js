'use strict';

const { randomUUID } = require('crypto');
const { isNetworkError } = require('../commands/_http');
const { VERSION } = require('../version');
const { ErrorCode, ManagementApiError } = require('./errors');

const API_PREFIX = '/api/v1';
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
// How much of a non-JSON error body to keep on the error, for a person to read.
const BODY_SNIPPET_LENGTH = 200;

const USER_AGENT = `end-point-blank-js/${VERSION} (management)`;

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The management client's HTTP layer: one `fetch` per attempt, the management
 * key as a Bearer token, an `Idempotency-Key` on every POST, and bounded
 * retries.
 *
 * Separate from `commands/_http.js`, which is the runtime client's helper for
 * calls to intake: that one sends HTTP Basic built from the runtime
 * credential and answers `null` on failure. Nothing here reads the runtime
 * configuration, so a runtime `clientId`/`clientSecret` can never reach
 * `/api/v1`. It shares only `isNetworkError`, so both decide "the request
 * never completed" the same way.
 *
 * What is retried (at most `maxRetries` times, the same `Idempotency-Key` on
 * every attempt of one POST):
 *
 * - 429 `rate_limited`, any method: the server refuses before it runs
 *   anything. Waits `Retry-After` seconds; an answer asking for longer than
 *   `maxRetryWaitMs` is thrown instead of waited on.
 * - 409 `idempotency_request_in_progress` (a POST): the first attempt is still
 *   running; asks again shortly with the same key.
 * - 5xx and network errors, for GET, DELETE and POST only. A POST is safe
 *   because its key makes the server run it once. A PATCH carries no key, so
 *   it is never retried after it may have reached the server.
 *
 * 409 `idempotency_replay_unavailable` is never retried: the first POST
 * succeeded but its answer held a secret shown once (a credential's secret, a
 * portal session's link), so asking again cannot return it.
 */
class Transport {
  #apiKey;
  #baseUrl;
  #fetch;
  #sleep;
  #maxRetries;
  #maxRetryWaitMs;
  #retryBaseDelayMs;
  #timeoutMs;

  constructor({ apiKey, baseUrl, fetch, sleep, maxRetries, maxRetryWaitMs, retryBaseDelayMs, timeoutMs }) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#fetch = fetch || null;
    this.#sleep = sleep || defaultSleep;
    this.#maxRetries = maxRetries;
    this.#maxRetryWaitMs = maxRetryWaitMs;
    this.#retryBaseDelayMs = retryBaseDelayMs;
    this.#timeoutMs = timeoutMs;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  /**
   * Sends one request and answers the parsed JSON body.
   *
   * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
   * @param {string} path under `/api/v1`, segments already encoded
   * @param {{query?: object, body?: object, idempotencyKey?: string}} [options]
   * @returns {Promise<object>}
   * @throws {ManagementApiError}
   */
  async request(method, path, { query, body, idempotencyKey } = {}) {
    const fullPath = API_PREFIX + path;
    const url = this.#baseUrl + fullPath + queryString(query);

    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Authorization: `Bearer ${this.#apiKey}`,
    };

    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let key = null;
    if (method === 'POST') {
      key = idempotencyKey === undefined || idempotencyKey === null
        ? randomUUID()
        : checkIdempotencyKey(idempotencyKey);
      headers['Idempotency-Key'] = key;
    }

    const context = { method, path: fullPath, idempotencyKey: key };

    for (let attempt = 0; ; attempt++) {
      let error;
      try {
        return await this.#attempt(url, { method, headers, body: payload }, context);
      } catch (err) {
        if (!(err instanceof ManagementApiError)) throw err;
        error = err;
      }

      const wait = this.#retryWait(method, error, attempt);
      if (wait === null) throw error;
      await this.#sleep(wait);
    }
  }

  async #attempt(url, init, context) {
    const fetchImpl = this.#fetch || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response;
    let text;
    try {
      // The API never redirects. 'manual' answers a 3xx as itself (an
      // http_error), so the Authorization header is never forwarded to
      // wherever a Location points (older Node 18 fetch did, cross-origin).
      response = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
      text = await response.text();
    } catch (err) {
      if (!isNetworkError(err)) throw this.#scrubbed(err, context);
      // The cause's message comes from the network stack (a host name, an
      // errno), never from a header, so it cannot hold the key.
      const reason = (err.cause && err.cause.code) || err.code || err.name;
      throw new ManagementApiError({
        code: ErrorCode.NETWORK_ERROR,
        message: `${context.method} ${context.path} did not complete (${reason}).`,
        ...context,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const parsed = parseJson(text);
    const status = response.status;

    if (status >= 200 && status < 300) {
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      throw new ManagementApiError({
        code: ErrorCode.INVALID_RESPONSE,
        message: `${context.method} ${context.path} answered ${status} without a JSON object body.`,
        status,
        ...context,
        ...answerHeaders(response),
      });
    }

    throw errorFromAnswer(status, parsed, text, response, context);
  }

  /**
   * What `fetch` threw that was not a network error, safe to hand on. A
   * `TypeError` is how `fetch` refuses to build a request (a header value it
   * cannot send), and its message quotes the offending header, which may be
   * `Authorization`; so it, and anything else that mentions the key, is
   * replaced by an error that does not. Anything else is thrown as itself.
   */
  #scrubbed(err, context) {
    const text = `${err && err.message} ${err && err.stack}`;
    if (!(err instanceof TypeError) && !text.includes(this.#apiKey)) return err;
    return new TypeError(
      `${context.method} ${context.path} could not be sent: fetch refused to build the request ` +
        `(${err && err.name}). Its message is withheld because it may quote a header.`
    );
  }

  /** Milliseconds to wait before the next attempt, or `null` to give up. */
  #retryWait(method, error, attempt) {
    if (attempt >= this.#maxRetries) return null;
    if (error.code === ErrorCode.IDEMPOTENCY_REPLAY_UNAVAILABLE) return null;

    const backoff = this.#retryBaseDelayMs * 2 ** attempt;

    if (error.status === 429) return this.#honour(error.retryAfter, backoff);

    if (error.code === ErrorCode.IDEMPOTENCY_REQUEST_IN_PROGRESS && method === 'POST') return backoff;

    const failed = error.status === null || error.status >= 500;
    if (failed && method !== 'PATCH') return this.#honour(error.retryAfter, backoff);

    return null;
  }

  #honour(retryAfter, fallback) {
    const wait = retryAfter === null ? fallback : retryAfter * 1000;
    return wait > this.#maxRetryWaitMs ? null : wait;
  }

  [INSPECT]() {
    return `Transport { baseUrl: '${this.#baseUrl}' }`;
  }

  toJSON() {
    return { baseUrl: this.#baseUrl };
  }
}

function errorFromAnswer(status, parsed, text, response, context) {
  const error = parsed && typeof parsed === 'object' ? parsed.error : null;
  const fields = { status, ...context, ...answerHeaders(response) };

  if (error && typeof error === 'object' && typeof error.code === 'string') {
    let message = typeof error.message === 'string' ? error.message : `The request failed (${error.code}).`;
    if (error.code === ErrorCode.IDEMPOTENCY_REPLAY_UNAVAILABLE) {
      message +=
        ' The first request with this Idempotency-Key succeeded, but its answer held a ' +
        'secret that is shown only once, so this SDK did not retry it. Read or list the ' +
        `resource to see its current state${fields.location ? ` (${fields.location})` : ''}; ` +
        'for a portal session, create a new one with a new key.';
    }
    return new ManagementApiError({
      code: error.code,
      message,
      details: error.details === undefined ? null : error.details,
      ...fields,
    });
  }

  const snippet = (text || '').trim().slice(0, BODY_SNIPPET_LENGTH);
  return new ManagementApiError({
    code: ErrorCode.HTTP_ERROR,
    message:
      `${context.method} ${context.path} answered ${status} without an error body` +
      (snippet ? `: ${JSON.stringify(snippet)}` : '.'),
    details: snippet ? { body: snippet } : null,
    ...fields,
  });
}

function answerHeaders(response) {
  const header = (name) => (response.headers && response.headers.get(name)) || null;
  return {
    retryAfter: parseRetryAfter(header('retry-after')),
    location: header('location'),
    requestId: header('x-request-id'),
  };
}

/** `Retry-After` as whole seconds: delta-seconds or an HTTP date. */
function parseRetryAfter(value) {
  if (value === null) return null;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(name, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function checkIdempotencyKey(key) {
  // Checked as sent: app_portal trims it but counts its length in bytes, and
  // a control character could not be sent in a header at all.
  if (
    typeof key !== 'string' ||
    key.trim() === '' ||
    new TextEncoder().encode(key).length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /[\x00-\x1f\x7f]/.test(key)
  ) {
    throw new TypeError(
      `idempotencyKey must be a non-blank string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} bytes, ` +
        'with no control characters.'
    );
  }
  return key;
}

module.exports = { Transport, USER_AGENT, API_PREFIX, parseRetryAfter };
