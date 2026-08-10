'use strict';

const { resolveBaseUrl } = require('../src/base-url');

describe('resolveBaseUrl', () => {
  const req = (overrides = {}) => ({
    protocol: 'https',
    socket: { localPort: 8443, encrypted: true },
    headers: { host: 'API.Example.com:8443', ...overrides.headers },
    ...overrides,
  });

  test('resolves scheme host and port from a direct request', () => {
    expect(resolveBaseUrl(req())).toEqual({ scheme: 'https', host: 'api.example.com', port: 8443 });
  });

  test('omits the port when it is the scheme default', () => {
    const resolved = resolveBaseUrl(req({
      socket: { localPort: 443, encrypted: true },
      headers: { host: 'api.example.com' },
    }));

    expect(resolved).toEqual({ scheme: 'https', host: 'api.example.com' });
  });

  test('reports what the caller used, not what the process sees', () => {
    const resolved = resolveBaseUrl(req({
      protocol: 'http',
      socket: { localPort: 8080 },
      headers: {
        host: 'internal.svc:8080',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api.example.com',
        'x-forwarded-port': '443',
      },
    }));

    expect(resolved).toEqual({ scheme: 'https', host: 'api.example.com' });
  });

  test('omits the connection port once a proxy is in front', () => {
    // 8080 is the internal listener. The caller never saw it, so reporting it
    // would be worse than reporting nothing.
    const resolved = resolveBaseUrl(req({
      protocol: 'http',
      socket: { localPort: 8080 },
      headers: { host: 'api.example.com', 'x-forwarded-proto': 'https' },
    }));

    expect(resolved).toEqual({ scheme: 'https', host: 'api.example.com' });
  });

  test('takes the last forwarded hop so a caller cannot prepend its own', () => {
    // A proxy that appends writes its own observation last; a value the caller
    // planted arrives to the left of it.
    const resolved = resolveBaseUrl(req({
      headers: {
        host: 'api.example.com',
        'x-forwarded-proto': 'https, http',
        'x-forwarded-host': 'evil.example, api.example.com',
      },
    }));

    expect(resolved.scheme).toBe('http');
    expect(resolved.host).toBe('api.example.com');
  });

  test('omits a field it cannot resolve rather than reporting null', () => {
    expect(resolveBaseUrl({ headers: {} })).toEqual({});
    expect(resolveBaseUrl(null)).toEqual({});
  });

  test('drops a host that is not shaped like a hostname', () => {
    const resolved = resolveBaseUrl(req({ headers: { host: 'api.example.com/../evil?x=1' } }));

    expect(resolved).not.toHaveProperty('host');
    expect(resolved).toEqual({ scheme: 'https', port: 8443 });
  });

  test('ignores the forwarded headers when proxy headers are not trusted', () => {
    // Same request as 'reports what the caller used', resolved both ways, so
    // the only difference between the two expectations is the flag. Off, the
    // request is not proxied at all, so 8080 is evidence again.
    const proxied = () => req({
      protocol: 'http',
      socket: { localPort: 8080 },
      headers: {
        host: 'internal.svc:8080',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api.example.com',
        'x-forwarded-port': '443',
      },
    });

    expect(resolveBaseUrl(proxied(), { trustProxyHeaders: true }))
      .toEqual({ scheme: 'https', host: 'api.example.com' });
    expect(resolveBaseUrl(proxied(), { trustProxyHeaders: false }))
      .toEqual({ scheme: 'http', host: 'internal.svc', port: 8080 });
  });

  test('normalizes the scheme to lowercase without a trailing colon', () => {
    // This library is the reason the rule exists: location.protocol and
    // URL#protocol both yield 'https:', and intake never rewrites a stored
    // row, so the first release's spelling is permanent.
    expect(resolveBaseUrl(req({ headers: { host: 'api.example.com', 'x-forwarded-proto': 'HTTPS' } })).scheme)
      .toBe('https');
    expect(resolveBaseUrl(req({ headers: { host: 'api.example.com', 'x-forwarded-proto': 'https:' } })).scheme)
      .toBe('https');
    expect(resolveBaseUrl(req({ protocol: 'https:', headers: { host: 'api.example.com' } })).scheme)
      .toBe('https');
  });

  test('keeps an IPv6 literal whole and splits its port off', () => {
    const resolved = resolveBaseUrl(req({ headers: { host: '[2001:DB8::1]:8443' } }));

    expect(resolved).toEqual({ scheme: 'https', host: '[2001:db8::1]', port: 8443 });
  });
});
