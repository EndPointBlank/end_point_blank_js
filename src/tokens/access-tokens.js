'use strict';

const REFRESH_BUFFER_MS = 2 * 60 * 1000; // 2 minutes
const MIN_TTL_MS = 30 * 1000; // 30 seconds

/**
 * Singleton cache for access tokens keyed by hostname.
 *
 * JavaScript is single-threaded, but to avoid stampedes during concurrent
 * async requests for the same hostname, per-hostname in-flight fetch promises
 * are stored and shared.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::AccessTokens`.
 */
class AccessTokens {
  constructor() {
    /** @type {Map<string, {token: string, expiredAt: Date}>} */
    this._tokens = new Map();
    /** @type {Map<string, Promise<string|null>>} */
    this._inflight = new Map();
  }

  /**
   * Returns a valid access token for *hostname*, fetching a new one if needed.
   *
   * @param {string} hostname
   * @returns {Promise<string|null>}
   */
  async token(hostname) {
    const key = hostname.toLowerCase();
    const entry = this._tokens.get(key);

    if (entry && entry.expiredAt > new Date(Date.now() + REFRESH_BUFFER_MS)) {
      return entry.token;
    }

    // Coalesce concurrent fetches for the same hostname
    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }

    const promise = this._fetch(key);
    this._inflight.set(key, promise);

    try {
      return await promise;
    } finally {
      this._inflight.delete(key);
    }
  }

  async _fetch(key) {
    const { GenerateAccessToken } = require('../commands/generate-access-token');
    const payload = await GenerateAccessToken.token(key);

    if (payload && payload.token) {
      this._tokens.set(key, {
        token: payload.token,
        expiredAt: parseExpiry(payload.expired_at),
      });
      return payload.token;
    }

    const error = payload?.error ?? 'unknown error';
    console.error(`[EndPointBlank] Failed to generate access token for ${key}: ${error}`);
    return null;
  }

  /**
   * Returns `true` if a non-expired token exists for *hostname*.
   *
   * @param {string} hostname
   * @returns {boolean}
   */
  exists(hostname) {
    const entry = this._tokens.get(hostname.toLowerCase());
    return Boolean(entry && entry.expiredAt > new Date(Date.now() + MIN_TTL_MS));
  }

  /**
   * Removes the cached token for *hostname*.
   *
   * @param {string} hostname
   */
  remove(hostname) {
    this._tokens.delete(hostname.toLowerCase());
  }

  /**
   * Clears all cached tokens.
   */
  clear() {
    this._tokens.clear();
  }
}

function parseExpiry(value) {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!isNaN(d)) return d;
  }
  // Default: 1 hour from now
  return new Date(Date.now() + 60 * 60 * 1000);
}

const instance = new AccessTokens();

// Expose static-style API matching the Ruby gem's `AccessTokens.token(hostname)`
module.exports = {
  AccessTokens: {
    token: (hostname) => instance.token(hostname),
    exists: (hostname) => instance.exists(hostname),
    remove: (hostname) => instance.remove(hostname),
    clear: () => instance.clear(),
    _instance: instance,
  },
};
