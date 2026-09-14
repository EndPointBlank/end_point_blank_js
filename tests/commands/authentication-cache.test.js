'use strict';

const { AuthenticationCache, instance } = require('../../src/commands/authentication-cache');
const { instance: config } = require('../../src/configuration');

beforeEach(() => {
  instance.clear();
  config.cacheTtl = 300;
});
afterEach(() => {
  instance.clear();
  config._reset();
});

test('store and retrieve credentials', () => {
  instance.store('key1', 'credentials1');
  expect(instance.retrieve('key1')).toBe('credentials1');
});

test('retrieve returns null for missing key', () => {
  expect(instance.retrieve('nonexistent')).toBeNull();
});

test('exists returns true for stored key', () => {
  instance.store('key1', 'creds');
  expect(instance.exists('key1')).toBe(true);
});

test('exists returns false for missing key', () => {
  expect(instance.exists('missing')).toBe(false);
});

test('remove deletes entry and returns credentials', () => {
  instance.store('key1', 'creds');
  const removed = instance.remove('key1');
  expect(removed).toBe('creds');
  expect(instance.retrieve('key1')).toBeNull();
});

test('remove returns null for missing key', () => {
  expect(instance.remove('missing')).toBeNull();
});

test('clear removes all entries', () => {
  instance.store('k1', 'a');
  instance.store('k2', 'b');
  instance.clear();
  expect(instance.size()).toBe(0);
});

test('size reflects entry count', () => {
  instance.store('k1', 'a');
  instance.store('k2', 'b');
  expect(instance.size()).toBe(2);
});

test('keys returns all stored keys', () => {
  instance.store('alpha', 'a');
  instance.store('beta', 'b');
  const keys = instance.keys();
  expect(keys).toContain('alpha');
  expect(keys).toContain('beta');
});

test('store ignores null credentials', () => {
  instance.store('key1', null);
  expect(instance.retrieve('key1')).toBeNull();
  expect(instance.exists('key1')).toBe(false);
});

test('expired entries return null', () => {
  // sc-755 review finding 4: this used to set cacheTtl = 0, which now means
  // *disabled* (store() inserts nothing), so the old version passed no
  // matter what expiry logic did or didn't do -- there was never an entry
  // to find. Use a genuinely small, still-enabled ttl and real elapsed time
  // instead, so this can actually fail if basic expiry breaks.
  jest.useFakeTimers();
  try {
    config.cacheTtl = 5;
    instance.store('key1', 'creds');

    jest.advanceTimersByTime(6_000); // past the 5s ttl

    expect(instance.retrieve('key1')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

describe('bounding the cache', () => {
  // Authorization is cached per client, route, method and version, so a busy
  // API with many API keys generates a very large key space. Without a cap the
  // cache grows for the life of the process and eventually OOMs it.
  test('stops growing once it is full', () => {
    for (let i = 0; i < 1500; i++) instance.store(`key-${i}`, `credentials-${i}`);

    expect(instance.size()).toBeLessThanOrEqual(1000);
  });

  test('keeps the most recently stored entries', () => {
    for (let i = 0; i < 1500; i++) instance.store(`key-${i}`, `credentials-${i}`);

    expect(instance.retrieve('key-1499')).toBe('credentials-1499');
    expect(instance.retrieve('key-0')).toBeNull();
  });

  test('reclaims an entry past its own write-time expiry before evicting live ones', () => {
    // A stale entry is worthless; dropping a live one to make room for a new
    // arrival while dead entries sit in the map would cost a real round-trip
    // to the authorize service. Here "stale" is past the *original* expiry
    // it was written with (10s, aged 11s) -- see the next test for the
    // sweep evicting an entry that is only stale under a *lowered* current
    // ttl, which this one does not exercise (sc-755 review finding 3).
    jest.useFakeTimers();
    try {
      config.cacheTtl = 10;
      instance.store('stale', 'old credentials');

      jest.advanceTimersByTime(11_000);

      config.cacheTtl = 300;
      instance.store('fresh', 'new credentials');

      expect(instance.keys()).toEqual(['fresh']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reclaims an entry stale only under the current, lowered ttl -- not yet past its original expiry', () => {
    // sc-755 review finding 3: the previous test above evicts an entry via
    // its own write-time expiry, which a sweep reverted to the pre-sc-755
    // `expiresAt <= now` check would already handle. This one is written
    // under a long ttl (300s, nowhere near its original expiry) and only
    // goes stale because cache_ttl is lowered afterward -- exercising the
    // `now - writtenAt < ttlSeconds * 1000` half of _isValid inside store()'s
    // sweep specifically.
    jest.useFakeTimers();
    try {
      config.cacheTtl = 300;
      instance.store('stale-under-new-ttl', 'old credentials'); // expiresAt = t0 + 300s

      config.cacheTtl = 10;
      jest.advanceTimersByTime(11_000); // 11s old: stale under the new 10s ttl, but far from the original 300s expiry

      instance.store('fresh', 'new credentials'); // triggers the sweep under ttl=10

      expect(instance.keys()).toEqual(['fresh']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a store that observes cache_ttl disabled inserts nothing AND clears the entire cache', () => {
    config.cacheTtl = 300;
    instance.store('already-cached', 'old credentials');

    config.cacheTtl = 0;
    instance.store('key', 'credentials'); // the disabled store itself

    // Not just "key" was refused -- the pre-existing entry is gone too.
    expect(instance.size()).toBe(0);
    expect(instance.keys()).toEqual([]);

    config.cacheTtl = 300;
    expect(instance.retrieve('already-cached')).toBeNull();
    expect(instance.retrieve('key')).toBeNull();
  });
});

test('an unset cache TTL falls back to the default rather than expiring at once', () => {
  // `config.cacheTtl = null` is a plausible way to try to "turn off" the
  // setting. Treating it as zero would make every request re-authorize.
  config.cacheTtl = null;

  instance.store('key', 'credentials');

  expect(instance.retrieve('key')).toBe('credentials');
});

// sc-755: the cache must consult cache_ttl AT READ TIME, not only at write
// time. Each of (a)-(d) fails on the pre-sc-755 implementation, which only
// ever compares `now` against an `expiredAt` fixed when the entry was
// written -- a runtime cache_ttl change (up or down, including disabling)
// never touches an already-cached entry.
describe('sc-755: cache_ttl is re-consulted on every read', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('(a) lowering cache_ttl makes an old-enough entry miss on the next read', () => {
    jest.useFakeTimers();

    config.cacheTtl = 300;
    instance.store('key', 'credentials');

    config.cacheTtl = 10;
    jest.advanceTimersByTime(11_000); // older than the new 10s ttl

    expect(instance.retrieve('key')).toBeNull();
  });

  test('(b) does not clamp on remaining-time-to-original-expiry (the bug this story fixes)', () => {
    jest.useFakeTimers();

    config.cacheTtl = 300;
    instance.store('key', 'credentials'); // expiresAt = t0 + 300s

    config.cacheTtl = 10;
    // Only 5s remain until the *original* 300s expiry -- a naive
    // `expiresAt - now <= currentTtl` clamp would see 5 <= 10 and call this
    // a hit. It must still miss: the entry is 295s old, far past the new 10s
    // window measured from writtenAt.
    jest.advanceTimersByTime(295_000);

    expect(instance.retrieve('key')).toBeNull();
  });

  test('(c) raising cache_ttl never extends an entry past its original expiry', () => {
    jest.useFakeTimers();

    config.cacheTtl = 10;
    instance.store('key', 'credentials'); // expiresAt = t0 + 10s

    config.cacheTtl = 300;
    jest.advanceTimersByTime(11_000); // past the original 10s expiry

    expect(instance.retrieve('key')).toBeNull();
  });

  test('(d) disabling the cache deletes the entry outright, and re-enabling does not resurrect it', () => {
    config.cacheTtl = 300;
    instance.store('key', 'credentials');
    expect(instance.size()).toBe(1);

    config.cacheTtl = 0;
    expect(instance.retrieve('key')).toBeNull();
    // Not merely hidden: actually removed from the underlying store.
    expect(instance.size()).toBe(0);
    expect(instance.keys()).toEqual([]);

    config.cacheTtl = 300;
    expect(instance.retrieve('key')).toBeNull();
    expect(instance.exists('key')).toBe(false);
  });

  test('(d2) AMENDED: a disabled read of ONE key clears every entry, so a different key misses after re-enable', () => {
    // Controller amendment after js#50 review: the original rule ("delete
    // the entry" in (d) above) let `configure({cacheTtl:0})` -> read key A
    // -> `configure({cacheTtl:300})` leave key B answering again -- a
    // revoked grant nobody happened to read while disabled resurfaced. This
    // must fail against a per-entry-only delete (i.e. against this PR's own
    // pre-amendment `_validEntry`, which only removed the looked-up key).
    config.cacheTtl = 300;
    instance.store('A', 'credentials-A');
    instance.store('B', 'credentials-B');
    expect(instance.size()).toBe(2);

    config.cacheTtl = 0;
    expect(instance.retrieve('A')).toBeNull(); // only A is looked up here

    // The ENTIRE cache is gone, not just A -- this is what fails against a
    // per-entry-only delete: B would still be size 1 / present at this point.
    expect(instance.size()).toBe(0);
    expect(instance.keys()).toEqual([]);

    config.cacheTtl = 300;
    expect(instance.retrieve('B')).toBeNull(); // not resurrected
  });

  test('(e) sanity: an unchanged ttl within its window is still a hit', () => {
    config.cacheTtl = 300;
    instance.store('key', 'credentials');

    expect(instance.retrieve('key')).toBe('credentials');
    expect(instance.exists('key')).toBe(true);
  });

  // sc-755 review finding 2: this used to call a private `_deleteStale`
  // helper directly to prove a compare-then-delete guard, but a blind
  // `delete(key)` passed every test in this file just the same -- the guard
  // was never exercised through any real call path. It cannot be: `store`,
  // `retrieve` and `exists` are fully synchronous with no `await`/yield
  // point, and JS's single-threaded execution model runs a synchronous
  // function to completion before anything else touches the process, so no
  // write can land between a stale entry's lookup and its delete inside
  // `_validEntry`. There is no scenario, real or simulated through the
  // public API, in which that matters here -- unlike Elixir/Java, where an
  // actual concurrent OS thread could race the delete. The guard and its
  // test were removed rather than kept as untestable ceremony; see the
  // "Concurrency" note in the class doc in authentication-cache.js.
});
