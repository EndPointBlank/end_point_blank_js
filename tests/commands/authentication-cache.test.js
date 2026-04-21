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
