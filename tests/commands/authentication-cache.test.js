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

test('expired entries return null', async () => {
  config.cacheTtl = 0;
  instance.store('key1', 'creds');
  // TTL of 0ms means immediately expired
  await new Promise((r) => setTimeout(r, 5));
  expect(instance.retrieve('key1')).toBeNull();
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

  test('reclaims entries the current ttl has invalidated before evicting live ones', () => {
    // A stale entry is worthless; dropping a live one to make room for a new
    // arrival while dead entries sit in the map would cost a real round-trip
    // to the authorize service. sc-755: "stale" is judged against the ttl in
    // force *now* (10s, aged past), not the ttl it was written under.
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

  test('a store while cache_ttl is disabled inserts nothing', () => {
    config.cacheTtl = 0;
    instance.store('key', 'credentials');

    expect(instance.size()).toBe(0);
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

  test('(e) sanity: an unchanged ttl within its window is still a hit', () => {
    config.cacheTtl = 300;
    instance.store('key', 'credentials');

    expect(instance.retrieve('key')).toBe('credentials');
    expect(instance.exists('key')).toBe(true);
  });

  test('concurrency: cleaning up a stale entry never deletes a fresh write for the same key', () => {
    // The delete triggered by finding a stale entry on read must be a
    // compare-then-delete against the exact stale value, never a blind
    // `delete(key)` -- otherwise it could remove a fresh entry that has
    // since replaced it under the same key.
    config.cacheTtl = 300;
    instance.store('key', 'old credentials');
    const staleEntry = instance._cache.get('key');

    // Simulate a fresh write landing for the same key before the stale
    // entry's cleanup runs.
    instance._cache.set('key', {
      credentials: 'new credentials',
      writtenAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    });

    instance._deleteStale('key', staleEntry);

    expect(instance.retrieve('key')).toBe('new credentials');
  });
});
