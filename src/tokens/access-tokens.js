'use strict';

const REFRESH_BUFFER_MS = 2 * 60 * 1000; // 2 minutes
const MIN_TTL_MS = 30 * 1000; // 30 seconds

/**
 * Singleton holding this process's access token.
 *
 * Intake issues a token against the application environment the authenticating
 * credential belongs to. The hostname sent with a generation request only
 * resolves the target server-side; it is not what the token is scoped to. A
 * process authenticates as exactly one application environment, so it holds
 * exactly one token, whatever hostnames its callers address it by.
 *
 * JavaScript is single-threaded, but a burst of concurrent requests would each
 * start their own exchange, so the in-flight promise is shared.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::AccessTokens`.
 */
class AccessTokens {
  constructor() {
    /** @type {{token: string, expiredAt: Date}|null} */
    this._entry = null;
    /** @type {Promise<string|null>|null} */
    this._inflight = null;
  }

  /**
   * Returns a valid access token, fetching a new one if none is held or the
   * held one is close to expiry.
   *
   * @param {string} hostname the hostname to send with a generation request. It
   *   tells intake which application environment to resolve and does not select
   *   which held token comes back — every caller shares one.
   * @returns {Promise<string|null>}
   */
  async token(hostname) {
    const entry = this._entry;
    if (usable(entry)) {
      return entry.token;
    }

    // Coalesce concurrent exchanges
    if (this._inflight) {
      return this._inflight;
    }

    const promise = this._fetch(hostname);
    this._inflight = promise;

    try {
      return await promise;
    } finally {
      this._inflight = null;
    }
  }

  async _fetch(hostname) {
    const { GenerateAccessToken } = require('../commands/generate-access-token');
    const payload = await GenerateAccessToken.token(hostname);

    if (payload && payload.token) {
      this._entry = {
        token: payload.token,
        expiredAt: parseExpiry(payload.expired_at),
      };
      return payload.token;
    }

    const error = payload?.error ?? 'unknown error';
    console.error(`[EndPointBlank] Failed to generate access token for ${hostname}: ${error}`);
    return null;
  }

  /**
   * Returns `true` if a token is held and is not about to expire.
   *
   * @returns {boolean}
   */
  exists() {
    return Boolean(this._entry && this._entry.expiredAt > new Date(Date.now() + MIN_TTL_MS));
  }

  /**
   * Discards the held token, but only if it is still the one the caller had.
   *
   * Every request in flight when a token is rejected reports the same stale
   * value. Only the first of them should cause an exchange — the rest are
   * holding a token that has already been replaced, and clearing on their
   * behalf would discard a good token and stampede intake.
   *
   * @param {string|null|undefined} staleToken the token the caller was rejected
   *   for; ignored when it is not the one currently held.
   */
  invalidate(staleToken) {
    if (staleToken == null) return;

    if (this._entry && this._entry.token === staleToken) {
      this._entry = null;
    }
  }

  /**
   * Discards the held token.
   */
  clear() {
    this._entry = null;
  }
}

function usable(entry) {
  return Boolean(entry && entry.expiredAt > new Date(Date.now() + REFRESH_BUFFER_MS));
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
    exists: () => instance.exists(),
    invalidate: (staleToken) => instance.invalidate(staleToken),
    clear: () => instance.clear(),
    _instance: instance,
  },
};
