'use strict';

const { RoutePatternFinder } = require('../../src/commands/route-pattern-finder');

describe('RoutePatternFinder.find', () => {
  test('returns the pattern the request matched', () => {
    // The pattern, not the concrete URL: `/users/42` and `/users/43` are one
    // endpoint, and reporting the URL would make every id its own endpoint.
    expect(RoutePatternFinder.find({ route: { path: '/users/:id' } })).toBe('/users/:id');
  });

  test('returns null when no route matched', () => {
    // The normal case for a 404, which still gets a response record.
    expect(RoutePatternFinder.find({ url: '/nope' })).toBeNull();
  });

  test('returns null when the matched route has no path', () => {
    expect(RoutePatternFinder.find({ route: {} })).toBeNull();
  });

  test.each([[null], [undefined]])('returns null for %p', req => {
    expect(RoutePatternFinder.find(req)).toBeNull();
  });

  test('returns null rather than throwing when the request resists inspection', () => {
    // Some frameworks and proxies expose `route` as a getter. This runs while
    // writing a response record, where an exception would be an outage.
    const hostile = {
      get route() {
        throw new Error('not available at this point in the lifecycle');
      },
    };

    expect(RoutePatternFinder.find(hostile)).toBeNull();
  });
});
