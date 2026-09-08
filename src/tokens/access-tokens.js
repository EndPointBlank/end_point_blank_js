'use strict';

const REFRESH_BUFFER_MS = 2 * 60 * 1000; // 2 minutes
const MIN_TTL_MS = 30 * 1000; // 30 seconds

// Ceiling on remembered failures. The record is keyed on the URL the caller
// asked for, which is a resource URL rather than an environment -- a service
// walking /orders/1, /orders/2, /orders/3 against a dead intake would
// otherwise accumulate one record per resource, forever, exactly the leak the
// token cache avoids by keying on the base URL intake resolves to. Insertion
// order is Map order, so the oldest record goes when the ceiling is reached.
const MAX_FAILURES = 64;

/**
 * Singleton holding this process's access tokens, one per application
 * environment.
 *
 * A token is cached under the canonical base URL intake resolved the request
 * to — not under the URL the caller supplied. A caller asks for the URL it is
 * about to call; intake answers with the base URL of the environment that URL
 * belongs to, and subsequent calls anywhere under that base URL reuse the
 * entry. A process that calls several targets therefore holds several
 * tokens.
 *
 * Lookup is a plain exact-or-path-prefix comparison, with the longest match
 * winning. The SDK deliberately does not normalize: intake owns that rule,
 * and a miss costs one extra request rather than a wrong answer.
 *
 * JavaScript is single-threaded, so — unlike the Python and Ruby ports —
 * there is no torn-read hazard and the entries map is mutated in place rather
 * than replaced on every write. A burst of concurrent requests would each
 * start their own exchange though, so in-flight fetches are coalesced, keyed
 * on the caller's URL (the response's `base_url` is not known until the
 * request returns).
 *
 * Equivalent to the Ruby gem's `EndPointBlank::AccessTokens`.
 */
class AccessTokens {
  constructor() {
    /** @type {Map<string, {token: string, expiredAt: Date}>} */
    this._entries = new Map();
    /** @type {Map<string, Promise<string|null>>} */
    this._inflight = new Map();
    /** @type {Map<string, {outcome: string, status: number|null}>} */
    this._failures = new Map();
  }

  /**
   * Returns a valid access token covering *baseUrl*, fetching one if no
   * usable entry covers it.
   *
   * @param {string} baseUrl the URL you are about to call, with any query
   *   string and fragment removed. It is sent verbatim; intake normalizes it
   *   and matches it against registered base URLs by longest path prefix.
   * @returns {Promise<string|null>} the access token, or `null` if generation
   *   failed — which includes a response that carried a token but no
   *   `base_url`.
   */
  async token(baseUrl) {
    const entry = this._match(baseUrl);
    if (usable(entry)) {
      return entry.token;
    }

    // Coalesce concurrent exchanges for the same requested URL.
    const pending = this._inflight.get(baseUrl);
    if (pending) {
      return pending;
    }

    const promise = this._fetch(baseUrl);
    this._inflight.set(baseUrl, promise);

    try {
      return await promise;
    } finally {
      this._inflight.delete(baseUrl);
    }
  }

  async _fetch(baseUrl) {
    const { GenerateAccessToken, TokenOutcome } = require('../commands/generate-access-token');

    // Captured once, before the mint, and reused by both outcomes below.
    // _inflight coalesces only by the caller's URL, not by environment (see
    // the class doc comment), so two different URLs under the same
    // environment run as two separate concurrent exchanges rather than being
    // queued behind one another. If this match were recomputed after the
    // await instead, a slower call could resolve to find that a faster,
    // unrelated concurrent call for a different URL under the same
    // environment had already stored a fresh entry that now happens to match
    // this URL too -- and a failure here would delete that good entry for a
    // problem that was never its own.
    const matchedKey = this._matchKey(baseUrl);
    const result = await GenerateAccessToken.tokenResult(baseUrl);

    // SUCCESS is the whole test, because SUCCESS already means a token was
    // minted: a 2xx whose body parsed and carried a non-empty `token` and
    // `base_url`. There is deliberately no second, hand-written reading of
    // the payload here to disagree with the classification -- that decision
    // lives once, next to the status it depends on, so the two layers cannot
    // drift apart when one of them is edited.
    if (result.outcome === TokenOutcome.SUCCESS) {
      const payload = result.payload;

      // The key is what intake resolved to, and only that. There is no
      // fallback to the requested URL: that would key on the resource the
      // caller happened to ask about, so a service walking /orders/1,
      // /orders/2, /orders/3 would mint and store a token per resource, and
      // nothing here evicts.
      const key = payload.base_url;

      // The key intake returned can differ from the one this URL matched
      // before the mint (a portal edit can shorten or lengthen an
      // environment's registered base URL). Without removing the old entry
      // it survives as a duplicate that, being longer, keeps winning the
      // longest-match comparison over the fresh one -- unusable, forcing a
      // mint on every subsequent call. The failure path below already drops
      // the entry it matched; do the same here so success is not the odd
      // one out.
      if (matchedKey !== null && matchedKey !== key) {
        this._entries.delete(matchedKey);
      }

      this._entries.set(key, {
        token: payload.token,
        expiredAt: parseExpiry(payload.expired_at),
      });
      // Whatever went wrong before is over; a stale record would have a
      // caller acting on an outage that has already ended.
      this._failures.delete(baseUrl);
      return payload.token;
    }

    // A failed refresh must not leave an expiring token behind claiming to be
    // usable — callers would keep presenting it right up to the 401. Only the
    // entry that covers this URL goes: the longest match is the one that was
    // found unusable *before the mint started*, so a shorter, still-good
    // entry survives -- and so does an entry a different concurrent call for
    // another URL in this same environment stored while this mint was in
    // flight.
    if (matchedKey !== null) {
      this._entries.delete(matchedKey);
    }

    // Recorded exactly as it was classified. A 2xx that carried no usable
    // token already arrives here as SERVER_ERROR -- intake's base_url is NOT
    // NULL, so a 201 without one cannot be anything the caller did, which
    // puts it with the retriable failures rather than with the rejections --
    // so there is nothing left for this layer to re-decide.
    this._recordFailure(baseUrl, result.outcome, result.status);

    if (result.outcome === TokenOutcome.CREDENTIAL_REJECTED) {
      // Deliberately not the generic line below. This one will not fix
      // itself: every subsequent request mints, gets another 401, and hands
      // the caller a Basic fallback it never asked for, until somebody reads
      // this and acts on it.
      console.error(
        `[EndPointBlank] Access token request for ${baseUrl} was REJECTED (HTTP 401): ` +
          'the client credential is invalid or revoked. Retrying cannot help -- ' +
          're-issue the credential and update this application\'s configuration.',
      );
      return null;
    }

    console.error(
      `[EndPointBlank] Failed to generate access token for ${baseUrl}: ${failureReason(result)}`,
    );
    return null;
  }

  /**
   * Remembers why the most recent mint for *baseUrl* produced no token.
   *
   * @param {string} baseUrl
   * @param {string} outcome
   * @param {number|null} status
   */
  _recordFailure(baseUrl, outcome, status) {
    // Re-inserting moves the key to the end of the Map's order, so a URL that
    // keeps failing is not evicted as though it were the oldest.
    this._failures.delete(baseUrl);
    if (this._failures.size >= MAX_FAILURES) {
      this._failures.delete(this._failures.keys().next().value);
    }
    this._failures.set(baseUrl, Object.freeze({ outcome, status: status != null ? status : null }));
  }

  /**
   * Why the last attempt to mint a token for *baseUrl* failed, or `null`.
   *
   * @param {string} baseUrl the URL that was asked for -- the same argument
   *   {@link AccessTokens#token} was called with, not the base URL intake
   *   resolves it to. A failed mint never learns the canonical base URL,
   *   so there is nothing else it could be keyed on.
   * @returns {{outcome: string, status: number|null}|null}
   */
  lastFailure(baseUrl) {
    const record = this._failures.get(baseUrl);
    return record !== undefined ? record : null;
  }

  /**
   * Returns `true` if a token covering *baseUrl* has 30+ seconds left.
   *
   * @param {string} baseUrl
   * @returns {boolean}
   */
  exists(baseUrl) {
    const entry = this._match(baseUrl);
    return Boolean(entry && entry.expiredAt > new Date(Date.now() + MIN_TTL_MS));
  }

  /**
   * Discards a held token, but only if it is still the one the caller had.
   *
   * Every request in flight when a token is rejected reports the same stale
   * value. Only the first of them should cause an exchange — the rest are
   * holding a token that has already been replaced, and clearing on their
   * behalf would discard a good token and stampede intake.
   *
   * The lookup is by token value because a rejected caller has a token, not a
   * URL.
   *
   * @param {string|null|undefined} staleToken the token the caller was
   *   rejected for; ignored when it is no longer the one held for its base
   *   URL.
   */
  invalidate(staleToken) {
    if (staleToken == null) return;

    for (const [key, entry] of this._entries) {
      if (entry.token === staleToken) {
        this._entries.delete(key);
      }
    }
  }

  /**
   * Discards every held token, and every remembered failure.
   */
  clear() {
    this._entries.clear();
    this._failures.clear();
  }

  /**
   * Returns the longest key covering *baseUrl*, or `null`.
   *
   * Deliberately not a port of intake's matcher: no normalization on either
   * side. A caller that passes a non-canonical URL simply misses and mints
   * again, which costs one HTTP call and is never a wrong answer.
   *
   * @param {string} baseUrl
   * @returns {string|null}
   */
  _matchKey(baseUrl) {
    // A nil/undefined/empty argument matches nothing, by construction. This
    // is the whole fix for the nil-argument crash: without it, an empty
    // cache never runs the loop below and returns null "by accident", while
    // a warm cache runs it and calls `.startsWith` on a null/undefined
    // baseUrl. Handling it here up front makes the two cache states agree,
    // rather than raising a nicer error from within the loop.
    if (!baseUrl) return null;

    let best = null;
    for (const key of this._entries.keys()) {
      if (baseUrl === key || baseUrl.startsWith(key + '/')) {
        if (best === null || key.length > best.length) {
          best = key;
        }
      }
    }
    return best;
  }

  _match(baseUrl) {
    const key = this._matchKey(baseUrl);
    return key !== null ? this._entries.get(key) : null;
  }
}

function usable(entry) {
  return Boolean(entry && entry.expiredAt > new Date(Date.now() + REFRESH_BUFFER_MS));
}

/**
 * Why a mint produced no usable token, for the log.
 *
 * Only ever called on a failure — the success branch of `_fetch` has already
 * returned — so it reports on the status, and never has to ask what the
 * outcome was.
 */
function failureReason(result) {
  // A transport error is by definition one with no status to report.
  if (result.status == null) return 'no response';

  const payload = result.payload;

  // A 2xx only reaches here as a broken server: the status said yes and no
  // token could be read out of what came with it. It is reported under the
  // real status it arrived with -- calling a 201 "no response" would send
  // whoever reads this line hunting a network fault that never happened --
  // and says which part of the body was the problem.
  if (result.status >= 200 && result.status < 300) {
    return `HTTP ${result.status} (${bodyProblem(payload)})`;
  }

  const stated = statedError(payload);
  if (stated) return `HTTP ${result.status}: ${stated}`;
  // Classified on the status, so a body that would not parse costs only the
  // payload -- say which of the two happened.
  return payload === null ? `HTTP ${result.status} (unreadable body)` : `HTTP ${result.status}`;
}

/** What was wrong with the body of a 2xx that minted nothing. */
function bodyProblem(payload) {
  // Nothing to read a token out of at all: a body that would not parse (the
  // payload is null, and the parse error was logged where it happened), a
  // bare `null`, or a body that is not a JSON object -- `response.json()`
  // resolves happily to a string, a number or an array.
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'no usable body';
  }

  if (!(typeof payload.token === 'string' && payload.token !== '')) {
    return statedError(payload) || 'no token in response';
  }

  // Distinct from a rejected request: intake's base_url is NOT NULL, and it
  // answers 422 rather than minting when the caller's URL resolves to no
  // environment. A 201 without one is a broken server, and there is nothing
  // to cache the token under.
  return 'response carried a token but no base_url';
}

/** intake's own reason for the failure, when it sent one worth printing. */
function statedError(payload) {
  if (payload === null || typeof payload !== 'object') return null;

  // A misbehaving intake sending a nested object or a number where a string
  // belongs must not turn this log line into "[object Object]"; fall through
  // to the generic reason instead.
  const stated = payload.error;
  return typeof stated === 'string' && stated !== '' ? stated : null;
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

// Expose static-style API matching the Ruby gem's `AccessTokens.token(baseUrl)`
module.exports = {
  AccessTokens: {
    token: (baseUrl) => instance.token(baseUrl),
    exists: (baseUrl) => instance.exists(baseUrl),
    invalidate: (staleToken) => instance.invalidate(staleToken),
    lastFailure: (baseUrl) => instance.lastFailure(baseUrl),
    clear: () => instance.clear(),
    _instance: instance,
  },
};
