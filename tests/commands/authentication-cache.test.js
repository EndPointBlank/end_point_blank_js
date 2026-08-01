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

  test('reclaims expired entries before evicting live ones', () => {
    // An expired entry is worthless; dropping a live one to make room for a
    // new arrival while dead entries sit in the map would cost a real
    // round-trip to the authorize service.
    config.cacheTtl = -1;
    instance.store('stale', 'old credentials');

    config.cacheTtl = 300;
    instance.store('fresh', 'new credentials');

    expect(instance.keys()).toEqual(['fresh']);
  });
});

test('an unset cache TTL falls back to the default rather than expiring at once', () => {
  // `config.cacheTtl = null` is a plausible way to try to "turn off" the
  // setting. Treating it as zero would make every request re-authorize.
  config.cacheTtl = null;

  instance.store('key', 'credentials');

  expect(instance.retrieve('key')).toBe('credentials');
});
