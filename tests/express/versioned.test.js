'use strict';

const { versioned, getVersions } = require('../../src/express/versioned');

test('versioned attaches _epbVersions to middleware', () => {
  const mw = versioned(['v1', 'v2'], { state: 'Current' });
  expect(mw._epbVersions).toEqual({ Current: ['v1', 'v2'] });
});

test('versioned uses __default__ state when none specified', () => {
  const mw = versioned(['v1']);
  expect(mw._epbVersions).toHaveProperty('__default__', ['v1']);
});

test('versioned middleware is a pass-through no-op at runtime', () => {
  const mw = versioned(['v1']);
  const next = jest.fn();
  mw({}, {}, next);
  expect(next).toHaveBeenCalled();
});

test('getVersions reads metadata from a handler', () => {
  const mw = versioned(['v1', 'v2'], { state: 'Current' });
  expect(getVersions(mw)).toEqual({ Current: ['v1', 'v2'] });
});

test('getVersions returns empty object for unversioned handlers', () => {
  const handler = () => {};
  expect(getVersions(handler)).toEqual({});
});

test('getVersions handles null/undefined gracefully', () => {
  expect(getVersions(null)).toEqual({});
  expect(getVersions(undefined)).toEqual({});
});
