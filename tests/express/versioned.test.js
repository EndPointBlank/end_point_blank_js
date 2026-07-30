'use strict';

const { versioned, getVersions } = require('../../src/express/versioned');

test('versioned attaches the versions as a flat array', () => {
  const mw = versioned(['v1', 'v2']);
  expect(mw._epbVersions).toEqual(['v1', 'v2']);
});

test('versioned deduplicates while preserving declaration order', () => {
  // Keeps the manifest stable between deploys — otherwise the payload churns
  // and every deploy looks like a change.
  const mw = versioned(['v2', 'v1', 'v2']);
  expect(mw._epbVersions).toEqual(['v2', 'v1']);
});

test('versioned middleware is a pass-through no-op at runtime', () => {
  const mw = versioned(['v1']);
  const next = jest.fn();
  mw({}, {}, next);
  expect(next).toHaveBeenCalled();
});

test('getVersions reads metadata from a handler', () => {
  const mw = versioned(['v1', 'v2']);
  expect(getVersions(mw)).toEqual(['v1', 'v2']);
});

test('versioned([]) is a declaration, distinct from never declaring', () => {
  // The endpoint is still reported, with no version attached. Collapsing this
  // to the same value as "undeclared" would make it vanish from the manifest.
  expect(getVersions(versioned([]))).toEqual([]);
  expect(getVersions(() => {})).toBeUndefined();
});

test('getVersions handles null/undefined gracefully', () => {
  expect(getVersions(null)).toBeUndefined();
  expect(getVersions(undefined)).toBeUndefined();
});
