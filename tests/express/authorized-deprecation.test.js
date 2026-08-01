'use strict';

const { RequestStore } = require('../../src/request-store');
const { DeprecationHeaders } = require('../../src/deprecation-headers');

jest.mock('../../src/commands/endpoint-authorize', () => ({
  EndpointAuthorize: { authorize: jest.fn() },
}));

jest.mock('../../src/commands/version-finder', () => ({
  VersionFinder: { find: jest.fn(() => '1') },
}));

const { EndpointAuthorize } = require('../../src/commands/endpoint-authorize');
const { authorized } = require('../../src/express/authorized');

// The provider writes no code: the portal deprecated the version, authorize
// relayed the dates, and the response acquires the headers on its way out.
//
// These go through the middleware because the timing is the part worth
// protecting — the headers must be set before the route runs, since
// reportInteraction only sees the response on `finish`, by which point they
// have already been sent.
describe('authorized middleware — deprecation headers', () => {
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

  const req = { headers: {}, baseUrl: '', path: '/things', url: '/things', method: 'GET' };

  beforeEach(() => {
    EndpointAuthorize.authorize.mockReset();
    EndpointAuthorize.authorize.mockResolvedValue({ status: 201, ok: true });
  });

  const runWithDeprecation = async deprecation => {
    const res = fakeRes();

    await new Promise(resolve => {
      RequestStore.run(req, async () => {
        RequestStore.setDeprecation(deprecation);
        await authorized(req, res, resolve);
      });
    });

    return res;
  };

  test('sets both headers when the version is deprecated with a date', async () => {
    const res = await runWithDeprecation({
      deprecated_at: '2026-01-01T00:00:00Z',
      sunset_at: '2026-11-11T11:11:11Z',
    });

    expect(res.headers.Deprecation).toBe('@1767225600');
    expect(res.headers.Sunset).toBe('Wed, 11 Nov 2026 11:11:11 GMT');
  });

  test('sets Deprecation alone when no sunset date is set', async () => {
    const res = await runWithDeprecation({ deprecated_at: '2026-01-01T00:00:00Z' });

    expect(res.headers.Deprecation).toBeDefined();
    expect(res.headers.Sunset).toBeUndefined();
  });

  test('sets nothing when the version is not deprecated', async () => {
    const res = await runWithDeprecation(null);

    expect(res.headers).toEqual({});
  });

  test('sets nothing when authorization failed', async () => {
    EndpointAuthorize.authorize.mockResolvedValue({
      status: 403,
      json: async () => ({ error: 'denied' }),
      text: async () => 'denied',
    });

    const res = fakeRes();
    const next = jest.fn();

    await RequestStore.run(req, async () => {
      RequestStore.setDeprecation({ deprecated_at: '2026-01-01T00:00:00Z' });
      await authorized(req, res, next);
    });

    // A denied request gets an error, not advice about a version it may not call.
    expect(res.headers).toEqual({});
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('RequestStore isolation', () => {
  // AsyncLocalStorage scopes the context to this request's async call chain, so
  // a concurrent request cannot read it and nothing needs cleaning up. This is
  // the JS equivalent of holding the value in the Rack env rather than a
  // thread-local.
  test('concurrent requests do not see each other\'s deprecation', async () => {
    const seen = [];

    const one = RequestStore.run({}, async () => {
      RequestStore.setDeprecation({ deprecated_at: '2026-01-01T00:00:00Z' });
      await new Promise(r => setTimeout(r, 5));
      seen.push(['one', RequestStore.getDeprecation()?.deprecated_at]);
    });

    const two = RequestStore.run({}, async () => {
      RequestStore.setDeprecation({ deprecated_at: '2027-01-01T00:00:00Z' });
      await new Promise(r => setTimeout(r, 1));
      seen.push(['two', RequestStore.getDeprecation()?.deprecated_at]);
    });

    await Promise.all([one, two]);

    expect(seen).toContainEqual(['one', '2026-01-01T00:00:00Z']);
    expect(seen).toContainEqual(['two', '2027-01-01T00:00:00Z']);
  });

  test('returns null outside any request', () => {
    expect(RequestStore.getDeprecation()).toBeNull();
  });
});
