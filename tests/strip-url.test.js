'use strict';

const { stripUrl } = require('../src/strip-url');

describe('stripUrl (sc-1469)', () => {
  test.each([
    ['userinfo, query and fragment', 'https://u:p@api.test:8443/v1/x?k=s#f', 'https://api.test:8443/v1/x'],
    ['an empty query', 'https://api.test/v1?', 'https://api.test/v1'],
    ['an empty fragment', 'https://api.test/v1#', 'https://api.test/v1'],
    ['no path', 'https://api.test', 'https://api.test'],
    ['no path, with a query', 'https://api.test?k=s', 'https://api.test'],
    ['a bare trailing slash', 'https://api.test/', 'https://api.test/'],
    ['an IPv6 host', 'http://[::1]:4001/orders?x=1', 'http://[::1]:4001/orders'],
  ])('%s', (_label, raw, expected) => {
    expect(stripUrl(raw)).toBe(expected);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a relative path', '/orders'],
    ['no host', 'mailto:ops@api.test'],
    ['unparseable text', 'not a url'],
  ])('answers null for %s', (_label, raw) => {
    expect(stripUrl(raw)).toBeNull();
  });
});
