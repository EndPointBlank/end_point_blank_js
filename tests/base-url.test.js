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

  test('omits scheme and port when a proxy reports host and port but never proto', () => {
    // Finding A: the default-port comparison runs against the *resolved*
    // scheme. With no X-Forwarded-Proto the scheme never resolves, so a port
    // here would be unclassifiable (is 443 this scheme's default, or a real
    // port?) rather than merely unconfirmed. Omit it instead of guessing.
    const resolved = resolveBaseUrl(req({
      headers: {
        host: 'internal.svc',
        'x-forwarded-host': 'api.example.com',
        'x-forwarded-port': '443',
      },
    }));

    expect(resolved).toEqual({ host: 'api.example.com' });
  });

  test('ignores a malformed X-Forwarded-Port rather than letting it blank the scheme or port', () => {
    // Finding B: whether a request "is proxied" must be decided from validated
    // headers, not raw presence. An unauthenticated caller sending garbage in
    // X-Forwarded-Port must not be able to suppress the connection/authority
    // fallback for every request they make.
    const resolved = resolveBaseUrl(req({
      protocol: 'https',
      socket: { localPort: 8080, encrypted: true },
      headers: { host: 'api.example.com:9000', 'x-forwarded-port': 'not-a-port' },
    }));

    expect(resolved).toEqual({ scheme: 'https', host: 'api.example.com', port: 9000 });
  });

  test('ignores a malformed X-Forwarded-Proto rather than letting it erase the scheme', () => {
    // The junk proto must not blank the scheme: it is treated as though the
    // header were never sent, so the scheme falls through to the connection
    // exactly as it would with no X-Forwarded-Proto at all.
    const resolved = resolveBaseUrl(req({
      headers: {
        host: 'internal.svc',
        'x-forwarded-proto': 'not a scheme',
        'x-forwarded-host': 'api.example.com',
      },
    }));

    expect(resolved.scheme).toBe('https');
    expect(resolved.host).toBe('api.example.com');
  });

  test('drops a host longer than DNS allows, while the other fields still resolve', () => {
    // DNS caps a hostname at 253 characters, and nothing upstream validates
    // X-Forwarded-Host, so a caller can hand this an arbitrarily long one.
    // Dropped, not truncated: a truncated hostname is a plausible-looking
    // wrong value, and the portal reads this field verbatim.
    const resolved = resolveBaseUrl(req({
      headers: {
        'x-forwarded-host': 'a'.repeat(300),
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '8443',
      },
    }));

    expect(resolved).not.toHaveProperty('host');
    expect(resolved.scheme).toBe('https');
    expect(resolved.port).toBe(8443);
  });

  test('keeps a 253-byte host and drops a 254-byte one', () => {
    expect(resolveBaseUrl(req({ headers: { host: 'a'.repeat(253) } })).host).toBe('a'.repeat(253));
    expect(resolveBaseUrl(req({ headers: { host: 'a'.repeat(254) } }))).not.toHaveProperty('host');
  });
});
