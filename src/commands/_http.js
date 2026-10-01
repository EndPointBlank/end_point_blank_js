'use strict';

const { VERSION } = require('../version');

/**
 * The `x-epb-sdk` value sent on every call to intake: `js/<version>`, the
 * version of this library from its `package.json` (sc-1463). intake ignores
 * it today; it is there so intake can record the oldest version seen per
 * credential for the move gate. That gate's minimum JS version is the release
 * that turns `deriveBaseUrlFromClientId` on by default, not the one that
 * added this header: with the option at its default, this version keeps
 * calling `in.endpointblank.com` after its organization moves.
 */
const SDK_HEADER = `js/${VERSION}`;

// Per-attempt total timeout budget for a single fetch() call. This is a
// fire-and-forget telemetry send, so 15s was needlessly generous; 8s is a
// more sensible ceiling (roughly a ~3s connect + ~5s read budget).
//
// Native `fetch` (via AbortController/AbortSignal) only supports a single
// total deadline per request - there is no way to separately bound the
// connect phase vs. the read/response phase as some HTTP clients allow.
// Splitting them would require a lower-level client (e.g. Node's `http`
// module directly), which is out of scope here, so we just tighten the one
// knob we have.
const TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 200;
const MAX_ATTEMPTS = 3;

/**
 * Internal HTTP helper shared across command modules.
 * Uses the native `fetch` API available since Node 18.
 */

/**
 * POSTs `body` as JSON to `url` with the given `authHeader`.
 * Retries up to 3 times with a 200 ms delay between attempts on network error.
 *
 * Only a network error (see {@link isNetworkError}) is retried and answered
 * `null`. Anything else -- a URL `fetch` cannot parse, a body that will not
 * serialize, a bug -- is thrown on the first attempt (sc-1469): retrying it
 * cannot help, and answering `null` would have the caller report "intake
 * could not be reached" and send whoever reads that off to check a network
 * that was fine.
 *
 * @param {string} url
 * @param {string} authHeader
 * @param {object} body
 * @returns {Promise<Response|null>} The fetch Response, or `null` when every
 *   attempt failed with a network error.
 * @throws {Error} anything `fetch` throws that is not a network error, and
 *   whatever `JSON.stringify(body)` throws. Nothing is retried for it.
 */
async function post(url, authHeader, body) {
  // Outside the loop: a body that cannot be serialized is never a network
  // error, and no attempt could fix it.
  const payload = JSON.stringify(body);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          'x-epb-sdk': SDK_HEADER,
        },
        body: payload,
        signal: controller.signal,
      });
      return response;
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      console.error(`[EndPointBlank] HTTP POST to ${url} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Socket-level failures, as Node reports them on an error (or its `cause`)
// when the request never completed.
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
]);

/**
 * True when *err* means the request never completed: our own timeout fired
 * (`AbortError`/`TimeoutError`), or the connection failed. Node's `fetch`
 * reports every connection failure as a `TypeError` whose message is exactly
 * `fetch failed`, with the socket error as its `cause`; an unparseable URL is
 * a `TypeError` too, but with a different message, and is not one of these.
 * The `code` check covers a `fetch` that throws the socket error directly.
 *
 * The same distinction as the Ruby gem's `GenerateAccessToken::TRANSPORT_ERRORS`.
 *
 * @param {*} err
 * @returns {boolean}
 */
function isNetworkError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  if (NETWORK_CODES.has(err.code)) return true;
  if (typeof err.code === 'string' && err.code.startsWith('UND_ERR_')) return true;
  return false;
}

module.exports = { post, isNetworkError, SDK_HEADER };
