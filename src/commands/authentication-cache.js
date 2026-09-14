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
 * sc-755: `cache_ttl` is re-consulted on every read, not just at write time.
 * Each entry records `writtenAt` and the `expiresAt` fixed from the ttl in
 * effect when it was written. A read is a hit only when BOTH hold, checked
 * fresh against `config.cacheTtl` as configured right now:
 *   - `now < expiresAt`            -- raising cache_ttl later never extends
 *                                     an entry past what it was written for.
 *   - `now - writtenAt < ttlNow`   -- lowering cache_ttl takes effect on the
 *                                     very next read, even though `expiresAt`
 *                                     itself hasn't changed.
 * Deliberately NOT `expiresAt - now <= ttlNow` (a remaining-time clamp):
 * once enough real time passes, an old entry's time-remaining-until-its-
 * original-expiry can coincidentally fall back under a new, shorter ttl and
 * look valid again even though it is well past what the new ttl allows.
 *
 * `cache_ttl <= 0` (after defaulting `null`/`undefined` to 300) means
 * disabled: every read is a miss and deletes the entry outright (not merely
 * hides it), and `store()` inserts nothing while disabled. This matches the
 * Elixir SDK's sc-660 fix, so re-enabling the cache afterward cannot
 * resurrect what was flushed while it was off.
 *
 * A stale entry found on read is removed with a compare-then-delete against
 * the exact object read, never a blind `delete(key)` -- so a fresh write for
 * the same key can never be raced away by the cleanup of a stale one it
 * replaced.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::AuthenticationCache`.
 */
class AuthenticationCache {
  constructor() {
    /** @type {Map<string, {credentials: *, writtenAt: number, expiresAt: number}>} */
    this._cache = new Map();
  }

  /** Returns the effective `cache_ttl` in seconds, defaulting `null`/`undefined` to 300. */
  static _currentTtlSeconds() {
    return config.cacheTtl ?? 300;
  }

  /** `cache_ttl <= 0` disables the cache outright. */
  static _isDisabled(ttlSeconds) {
    return ttlSeconds <= 0;
  }

  /**
   * Whether *entry* is still a hit right now, under *ttlSeconds* (the
   * cache_ttl in effect at the moment of the check, which may differ from
   * the ttl in effect when *entry* was written).
   *
   * @param {{writtenAt: number, expiresAt: number}} entry
   * @param {number} ttlSeconds the cache_ttl to check against
   * @param {number} now `Date.now()`, passed in so callers checking many
   *   entries (store()'s eviction sweep) use one consistent timestamp
   * @returns {boolean}
   */
  static _isValid(entry, ttlSeconds, now) {
    if (AuthenticationCache._isDisabled(ttlSeconds)) return false;
    return now < entry.expiresAt && now - entry.writtenAt < ttlSeconds * 1000;
  }

  /**
   * Deletes the entry at *key* only if it is still exactly *expectedEntry* --
   * a compare-then-delete so cleanup of a stale read never clobbers a fresh
   * write that has since replaced it under the same key.
   */
  _deleteStale(key, expectedEntry) {
    if (this._cache.get(key) === expectedEntry) {
      this._cache.delete(key);
    }
  }

  /**
   * Stores *credentials* under *key* if non-null/undefined.
   *
   * Inserts nothing while the cache is disabled (`cache_ttl <= 0`) -- writing
   * an entry the cache would immediately treat as disabled-and-deleted on
   * the next read would just be a slower way of doing nothing.
   *
   * @param {string} key
   * @param {*} credentials
   */
  store(key, credentials) {
    if (credentials == null) return;

    const ttlSeconds = AuthenticationCache._currentTtlSeconds();
    if (AuthenticationCache._isDisabled(ttlSeconds)) return;

    const now = Date.now();

    // Evict entries that are no longer valid under the *current* ttl,
    // matching the same rule reads use -- so a store() opportunistically
    // reclaims space from entries a lowered ttl already invalidated, not
    // only ones expired under the ttl they were written with.
    for (const [k, v] of this._cache) {
      if (!AuthenticationCache._isValid(v, ttlSeconds, now)) this._cache.delete(k);
    }

    // Evict oldest insertions if at capacity (Map.keys() preserves order)
    while (this._cache.size >= MAX_SIZE) {
      this._cache.delete(this._cache.keys().next().value);
    }

    this._cache.set(key, {
      credentials,
      writtenAt: now,
      expiresAt: now + ttlSeconds * 1000,
    });
  }

  /**
   * Looks up *key* against the cache_ttl configured right now, deleting the
   * entry (not merely hiding it) and returning `null` if it is stale or the
   * cache is currently disabled. See the class doc for the exact rule.
   *
   * @param {string} key
   * @returns {{credentials: *, writtenAt: number, expiresAt: number}|null}
   */
  _validEntry(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;

    const ttlSeconds = AuthenticationCache._currentTtlSeconds();
    const now = Date.now();

    if (AuthenticationCache._isValid(entry, ttlSeconds, now)) {
      return entry;
    }

    this._deleteStale(key, entry);
    return null;
  }

  /**
   * Returns credentials for *key* if they exist and have not expired.
   *
   * @param {string} key
   * @returns {*} The cached credentials, or `null` if absent or expired.
   */
  retrieve(key) {
    const entry = this._validEntry(key);
    return entry ? entry.credentials : null;
  }

  /**
   * Returns `true` if a non-expired entry exists for *key*.
   *
   * @param {string} key
   * @returns {boolean}
   */
  exists(key) {
    return Boolean(this._validEntry(key));
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
