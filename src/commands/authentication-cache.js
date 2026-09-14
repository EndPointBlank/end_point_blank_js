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
 * disabled. **AMENDED 2026-09-14** (controller ruling after js#50 review):
 * any `retrieve`/`exists` OR `store` call that *observes* the cache disabled
 * clears the ENTIRE cache -- every entry, not only the key that call looked
 * up or was about to write -- and a disabled `store()` still inserts
 * nothing afterward. This matches the Elixir SDK's `AuthCache` (sc-660),
 * which clears its whole ETS table on any `get`/`put` made while disabled.
 *
 * **Known residual, matching Elixir exactly, not fixed by this story:** the
 * clear only happens on a call that *observes* the disabled state. A
 * `configure({cacheTtl: 0})` immediately followed by `configure({cacheTtl:
 * 300})`, with no `retrieve`/`exists`/`store` call in between, flushes
 * nothing -- nothing ever ran while disabled to trigger the clear, so every
 * entry keeps answering until its original expiry. An operator relying on
 * "disable then re-enable" to force-flush a revoked grant must make sure at
 * least one cache call (even a `retrieve` of a key that was never cached --
 * see the class doc's `_validEntry` note on checking disabled before the key)
 * happens while `cache_ttl` is at zero.
 *
 * **Precise trigger from the Express integration (`js#50` review, round 2):**
 * of the two guards, only `authorized` (`express/authorized.js` ->
 * `EndpointAuthorize.authorize` -> this module's `retrieve`/`store`) ever
 * calls into this cache. `authenticated` (`express/authenticated.js` ->
 * `BasicAuthenticate.authenticate`) never requires this file and never
 * touches `instance` -- so `authenticated`-only or unguarded traffic during
 * a disabled window does not count as "a call that observes disabled" above,
 * and cannot trigger the clear or the residual's escape hatch. Only an
 * `authorized` request, or a direct `retrieve`/`exists`/`store` call on
 * `instance`, does.
 *
 * The previous, narrower behavior -- deleting only the looked-up key while
 * disabled -- is what the original story text described and is still what
 * py#38/rails#38/java#37 implement; the controller widened the rule for all
 * five SDKs specifically because that narrower version let a revoked grant
 * answer again after a disable/re-enable cycle that never happened to read
 * it. See js#50 review comment and the amended `sc755-spec.md` rule 1/(d2).
 *
 * **Everything above is per-process (`js#50` review, round 3).** `config`
 * (imported above) and `this._cache` are both plain in-memory state private
 * to one Node process -- nothing here is shared, synchronized, or even
 * visible across processes. A `configure()` call, "currently disabled", and
 * the clear it can trigger all apply ONLY inside the process that runs them.
 * In a multi-worker deployment (PM2/Node `cluster`, several container/app
 * instances behind a load balancer, ...), each process has its own separate
 * `cacheTtl`, its own separate notion of disabled, and its own separate
 * cache Map. "Disable, let an `authorized` request through, re-enable" only
 * flushes the process(es) that go through all three steps themselves: it is
 * NOT fleet-wide, and nothing in this module coordinates it to be. A worker
 * that `configure({cacheTtl: 0})` never reaches, or that gets no `authorized`
 * traffic before being re-enabled, keeps its cache entirely untouched --
 * including a revoked grant still answering from it -- independent of every
 * other worker's state. There is no built-in way to disable, drain traffic
 * to, and re-enable every process in a fleet as one operation; confirming a
 * flush actually happened on every process is on the caller. (Restarting a
 * process starts it with an empty cache for the same reason: the cache lives
 * only in that process's memory.)
 *
 * A stale entry found on read under a still-*enabled* ttl (the ordinary
 * lowered-ttl case, not the disabled case above) is removed with a plain
 * `this._cache.delete(key)`. No compare-then-delete guard against a
 * concurrent fresh write is needed here: `_validEntry` and `store()` are
 * fully synchronous with no `await`/yield point, and JavaScript's
 * single-threaded execution model runs a synchronous function to completion
 * before anything else touches the process -- so nothing can insert a fresh
 * entry for the same key between this method's read of it and its delete.
 * (Contrast Elixir's `:ets.delete_object/2` and Java's
 * `ConcurrentHashMap.remove(key, value)`, both of which guard against real
 * OS-thread concurrency that JS does not have.)
 *
 * `keys()` and `size()` reflect the Map as last touched by a read or write --
 * an entry that nothing has looked up since it went stale is still counted
 * until the next `retrieve`/`exists`/`store` call that reaches it.
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
   * Callers must check `_isDisabled(ttlSeconds)` themselves first -- both
   * call sites (`_validEntry`, `store()`'s sweep) already do, to clear the
   * whole cache on that path (see class doc), so this never needs its own
   * disabled branch.
   *
   * @param {{writtenAt: number, expiresAt: number}} entry
   * @param {number} ttlSeconds the (already known non-disabled) cache_ttl to
   *   check against
   * @param {number} now `Date.now()`, passed in so callers checking many
   *   entries (store()'s eviction sweep) use one consistent timestamp
   * @returns {boolean}
   */
  static _isValid(entry, ttlSeconds, now) {
    return now < entry.expiresAt && now - entry.writtenAt < ttlSeconds * 1000;
  }

  /**
   * Stores *credentials* under *key* if non-null/undefined.
   *
   * If this call observes the cache disabled (`cache_ttl <= 0`), it clears
   * the ENTIRE cache -- not only refusing to insert *credentials* -- per the
   * amended rule 1 in the class doc above. That is a side effect independent
   * of the key/credentials passed in.
   *
   * @param {string} key
   * @param {*} credentials
   */
  store(key, credentials) {
    if (credentials == null) return;

    const ttlSeconds = AuthenticationCache._currentTtlSeconds();
    if (AuthenticationCache._isDisabled(ttlSeconds)) {
      this._cache.clear();
      return;
    }

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
   * Looks up *key* against the cache_ttl configured right now. Returns
   * `null` if absent, stale, or the cache is currently disabled.
   *
   * If this call observes the cache disabled, it clears the ENTIRE cache --
   * not only the entry for *key*, and regardless of whether *key* is even
   * present -- per the amended rule 1 in the class doc above. A merely-stale
   * entry under a still-enabled ttl is removed individually instead (plain
   * delete; see the class doc's "Concurrency" note for why no
   * compare-then-delete guard is needed here).
   *
   * @param {string} key
   * @returns {{credentials: *, writtenAt: number, expiresAt: number}|null}
   */
  _validEntry(key) {
    const ttlSeconds = AuthenticationCache._currentTtlSeconds();

    if (AuthenticationCache._isDisabled(ttlSeconds)) {
      this._cache.clear();
      return null;
    }

    const entry = this._cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (AuthenticationCache._isValid(entry, ttlSeconds, now)) {
      return entry;
    }

    this._cache.delete(key);
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
