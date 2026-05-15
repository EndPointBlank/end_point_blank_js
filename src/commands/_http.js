'use strict';

const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 3;

/**
 * Internal HTTP helper shared across command modules.
 * Uses the native `fetch` API available since Node 18.
 */

/**
 * POSTs `body` as JSON to `url` with the given `authHeader`.
 * Retries up to 3 times with a 500 ms delay between attempts on network error.
 *
 * @param {string} url
 * @param {string} authHeader
 * @param {object} body
 * @returns {Promise<Response|null>} The fetch Response, or `null` on network error.
 */
async function post(url, authHeader, body) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return response;
    } catch (err) {
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

module.exports = { post };
