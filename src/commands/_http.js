'use strict';

const TIMEOUT_MS = 15_000;

/**
 * Internal HTTP helper shared across command modules.
 * Uses the native `fetch` API available since Node 18.
 */

/**
 * POSTs `body` as JSON to `url` with the given `authHeader`.
 *
 * @param {string} url
 * @param {string} authHeader
 * @param {object} body
 * @returns {Promise<Response|null>} The fetch Response, or `null` on network error.
 */
async function post(url, authHeader, body) {
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
    console.error(`[EndPointBlank] HTTP POST to ${url} failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { post };
