'use strict';

const { instance: config } = require('../configuration');

const MAX_SIZE = 1000;

/**
 * Singleton cache for storing authentication credentials with TTL-based expiry
 * and a maximum entry cap.
 *
 * When full, expired entries are evicted first; if still at capacity the
 * oldest insertion is removed (Map preserves insertion order).
 *
 * JavaScript is single-threaded so no explicit locking is needed.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::AuthenticationCache`.
 */
class AuthenticationCache {
  constructor() {
    /** @type {Map<string, {credentials: *, expiredAt: Date}>} */
    this._cache = new Map();
  }

  /**
   * Stores *credentials* under *key* if non-null/undefined.
   *
   * @param {string} key
   * @param {*} credentials
   */
  store(key, credentials) {
    if (credentials == null) return;
    const ttlMs = (config.cacheTtl ?? 300) * 1000;
    const now = new Date();

    // Evict expired entries
    for (const [k, v] of this._cache) {
      if (v.expiredAt <= now) this._cache.delete(k);
    }

    // Evict oldest insertions if at capacity (Map.keys() preserves order)
    while (this._cache.size >= MAX_SIZE) {
      this._cache.delete(this._cache.keys().next().value);
    }

    this._cache.set(key, {
      credentials,
      expiredAt: new Date(Date.now() + ttlMs),
    });
  }

  /**
   * Returns credentials for *key* if they exist and have not expired.
   *
   * @param {string} key
   * @returns {*} The cached credentials, or `null` if absent or expired.
   */
  retrieve(key) {
    const entry = this._cache.get(key);
    if (entry && entry.expiredAt > new Date()) {
      return entry.credentials;
    }
    return null;
  }

  /**
   * Returns `true` if a non-expired entry exists for *key*.
   *
   * @param {string} key
   * @returns {boolean}
   */
  exists(key) {
    const entry = this._cache.get(key);
    return Boolean(entry && entry.expiredAt > new Date());
  }

  /**
   * Removes the entry for *key*.
   *
   * @param {string} key
   * @returns {*} The removed credentials, or `null` if not present.
   */
  remove(key) {
    const entry = this._cache.get(key);
    this._cache.delete(key);
    return entry?.credentials ?? null;
  }

  /**
   * Clears all cached entries.
   */
  clear() {
    this._cache.clear();
  }

  /**
   * Returns all current cache keys.
   *
   * @returns {string[]}
   */
  keys() {
    return [...this._cache.keys()];
  }

  /**
   * Returns the number of entries in the cache.
   *
   * @returns {number}
   */
  size() {
    return this._cache.size;
  }
}

const instance = new AuthenticationCache();

module.exports = { AuthenticationCache, instance };
