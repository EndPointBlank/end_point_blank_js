'use strict';

const { DeprecationHeaders } = require('../src/deprecation-headers');

// The vectors below are the shared set from app_portal's
// docs/superpowers/specs/2026-08-01-header-vectors.md. The same table is
// asserted in every SDK, so a JavaScript date format that differs from Ruby's
// by a leading zero is a test failure here rather than a subtly non-compliant
// header a customer finds.
//
// Row 1 is RFC 9745's own worked example. It is the reason to trust the rest.
const VECTORS = [
  ['2023-06-30T23:59:59Z', '@1688169599', 'Fri, 30 Jun 2023 23:59:59 GMT'],
  ['2026-01-01T00:00:00Z', '@1767225600', 'Thu, 01 Jan 2026 00:00:00 GMT'],
  ['2026-03-09T05:00:00Z', '@1773032400', 'Mon, 09 Mar 2026 05:00:00 GMT'],
  ['2026-08-01T14:15:16Z', '@1785593716', 'Sat, 01 Aug 2026 14:15:16 GMT'],
  ['2026-11-11T11:11:11Z', '@1794395471', 'Wed, 11 Nov 2026 11:11:11 GMT'],
];

describe('DeprecationHeaders.build', () => {
  describe('the shared vectors', () => {
    test.each(VECTORS)('formats %s to %s and %s', (iso, deprecation, sunset) => {
      const headers = DeprecationHeaders.build({ deprecated_at: iso, sunset_at: iso });

      expect(headers.Deprecation).toBe(deprecation);
      expect(headers.Sunset).toBe(sunset);
    });
  });

  describe('RFC conformance details', () => {
    test('zero-pads the day of month', () => {
      expect(DeprecationHeaders.build({ sunset_at: '2026-01-01T00:00:00Z' }).Sunset).toContain(
        ' 01 Jan '
      );
    });

    test('always says GMT, never UTC or an offset', () => {
      const sunset = DeprecationHeaders.build({ sunset_at: '2026-01-01T00:00:00Z' }).Sunset;

      expect(sunset.endsWith(' GMT')).toBe(true);
      expect(sunset).not.toContain('UTC');
      expect(sunset).not.toContain('+00');
    });

    test('converts a non-UTC input rather than relabelling it', () => {
      // 2026-01-01T00:00:00+02:00 is 2025-12-31T22:00:00Z.
      expect(DeprecationHeaders.build({ sunset_at: '2026-01-01T00:00:00+02:00' }).Sunset).toBe(
        'Wed, 31 Dec 2025 22:00:00 GMT'
      );
    });

    test('emits Deprecation unquoted and without sub-second precision', () => {
      expect(DeprecationHeaders.build({ deprecated_at: '2023-06-30T23:59:59.750Z' }).Deprecation).toBe(
        '@1688169599'
      );
    });
  });

  describe('partial and absent input', () => {
    test('emits Deprecation alone when there is no sunset date', () => {
      // The normal starting state: going away, no deadline committed yet.
      const headers = DeprecationHeaders.build({
        deprecated_at: '2026-01-01T00:00:00Z',
        sunset_at: null,
      });

      expect(headers.Deprecation).toBeDefined();
      expect(headers.Sunset).toBeUndefined();
    });

    test.each([[null], [undefined], [{}]])('returns nothing for %p', input => {
      expect(DeprecationHeaders.build(input)).toEqual({});
    });

    test('accepts camelCase keys as well as snake_case', () => {
      expect(DeprecationHeaders.build({ deprecatedAt: '2026-01-01T00:00:00Z' }).Deprecation).toBe(
        '@1767225600'
      );
    });
  });

  describe('never producing a plausible header from nonsense', () => {
    test('ignores a numeric value', () => {
      // `new Date(12345)` is a valid date in 1970. Coercing would turn a
      // nonsense value into a header that looks right and is wrong — the one
      // outcome worse than emitting nothing.
      expect(DeprecationHeaders.build({ deprecated_at: 12345 })).toEqual({});
    });

    test('ignores a malformed timestamp', () => {
      expect(DeprecationHeaders.build({ deprecated_at: 'not a date' })).toEqual({});
    });

    test('ignores non-object blocks', () => {
      expect(DeprecationHeaders.build('nonsense')).toEqual({});
      expect(DeprecationHeaders.build([1, 2, 3])).toEqual({});
    });

    test('still emits the good half when only one timestamp is bad', () => {
      const headers = DeprecationHeaders.build({
        deprecated_at: '2026-01-01T00:00:00Z',
        sunset_at: 'garbage',
      });

      expect(headers.Deprecation).toBe('@1767225600');
      expect(headers.Sunset).toBeUndefined();
    });
  });
});

describe('DeprecationHeaders.apply', () => {
  const fakeRes = () => {
    const headers = {};
    return {
      headers,
      headersSent: false,
      setHeader: (name, value) => {
        headers[name] = value;
      },
    };
  };

  test('sets both headers on the response', () => {
    const res = fakeRes();

    DeprecationHeaders.apply(res, {
      deprecated_at: '2026-01-01T00:00:00Z',
      sunset_at: '2026-11-11T11:11:11Z',
    });

    expect(res.headers.Deprecation).toBe('@1767225600');
    expect(res.headers.Sunset).toBe('Wed, 11 Nov 2026 11:11:11 GMT');
  });

  test('sets nothing when there is no deprecation', () => {
    const res = fakeRes();
    DeprecationHeaders.apply(res, null);
    expect(res.headers).toEqual({});
  });

  test('does nothing once headers have been sent', () => {
    // Setting a header after the response has gone out throws
    // ERR_HTTP_HEADERS_SENT. A missing header is a bug; a crash on a request
    // that already succeeded is an outage.
    const res = fakeRes();
    res.headersSent = true;

    DeprecationHeaders.apply(res, { deprecated_at: '2026-01-01T00:00:00Z' });

    expect(res.headers).toEqual({});
  });

  test('never throws into the response path', () => {
    expect(() => DeprecationHeaders.apply(null, { deprecated_at: '2026-01-01T00:00:00Z' })).not.toThrow();
    expect(() => DeprecationHeaders.apply({}, { deprecated_at: '2026-01-01T00:00:00Z' })).not.toThrow();
  });
});
