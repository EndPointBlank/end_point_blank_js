'use strict';

/**
 * Resolves the base URL the caller used — scheme, host and port — from an
 * Express/Node request.
 *
 * This deliberately does not use `req.hostname`, `req.protocol` or Express's
 * `trust proxy` setting. Rack, Express, the servlet spec and Plug each resolve
 * "host" differently (Rack takes the last X-Forwarded-Host hop, Express the
 * first, WSGI and Plug neither), which is why the same request produced five
 * different answers across the five clients. Headers are read directly so this
 * algorithm is the same one implemented in the Ruby, Python, Java and Elixir
 * libraries.
 *
 * Forwarded headers are honored when `trustProxyHeaders` is on, which it is by
 * default, taking the LAST hop: `host` was already caller-controlled everywhere,
 * and behind a proxy that appends, the last value is the proxy's own
 * observation. A directly-exposed deployment can pass `trustProxyHeaders: false`
 * and get scheme, host and port from the connection and the `Host` header only.
 *
 * The flag arrives as an argument rather than being read from the configuration
 * singleton here, so that this module stays framework- and config-free and both
 * states are directly testable.
 */

const HOSTNAME = /^[a-z0-9._-]+$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;
const DIGITS = /^[0-9]+$/;
const DEFAULT_PORTS = { http: 80, https: 443 };

/**
 * @param {object} req
 * @param {{trustProxyHeaders?: boolean}} [options] when `trustProxyHeaders` is
 *   false the three X-Forwarded-* headers are not read at all, so the request is
 *   never treated as proxied and the connection's scheme and port stay evidence.
 * @returns {{scheme?: string, host?: string, port?: number}} only the fields
 *   that resolved. An unresolvable field is absent, never null — the receiver
 *   has to be able to tell "not reported" from "reported as nothing".
 */
function resolveBaseUrl(req, { trustProxyHeaders = true } = {}) {
  if (!req) return {};
  const headers = req.headers || {};

  const forwardedProto = trustProxyHeaders ? _lastHop(headers['x-forwarded-proto']) : null;
  const forwardedHost = trustProxyHeaders ? _lastHop(headers['x-forwarded-host']) : null;
  const forwardedPort = trustProxyHeaders ? _lastHop(headers['x-forwarded-port']) : null;
  const proxied = forwardedProto !== null || forwardedHost !== null || forwardedPort !== null;

  const [hostPart, authorityPort] = _splitAuthority(
    forwardedHost || headers.host || req.hostname || req.host
  );

  const scheme = _cleanScheme(forwardedProto || (proxied ? null : _connectionScheme(req)));
  const host = _cleanHost(hostPart);
  const port = _cleanPort(
    forwardedPort || authorityPort || (proxied ? null : _connectionPort(req)),
    scheme
  );

  const resolved = {};
  if (scheme) resolved.scheme = scheme;
  if (host) resolved.host = host;
  if (port) resolved.port = port;
  return resolved;
}

function _lastHop(value) {
  if (typeof value !== 'string') return null;
  const hops = value.split(',').map(hop => hop.trim()).filter(hop => hop.length > 0);
  return hops.length ? hops[hops.length - 1] : null;
}

// "api.example.com:8443" -> ["api.example.com", "8443"]
// "[2001:db8::1]:8443"   -> ["[2001:db8::1]", "8443"]
function _splitAuthority(value) {
  if (typeof value !== 'string') return [null, null];
  const authority = value.trim();
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return [null, null];
    const rest = authority.slice(close + 1);
    return [authority.slice(0, close + 1), rest.startsWith(':') ? rest.slice(1) : null];
  }
  const colon = authority.indexOf(':');
  if (colon !== -1 && authority.indexOf(':', colon + 1) === -1) {
    return [authority.slice(0, colon), authority.slice(colon + 1)];
  }
  return [authority, null];
}

function _connectionScheme(req) {
  if (typeof req.protocol === 'string') return req.protocol;
  if (!req.socket) return null;
  return req.socket.encrypted ? 'https' : 'http';
}

function _connectionPort(req) {
  return req.socket && req.socket.localPort ? String(req.socket.localPort) : null;
}

// Normalize, then validate. This library is where the colon comes from:
// location.protocol and URL#protocol both yield 'https:'. intake never rewrites
// a stored row, so 'https:' and 'https' would be two permanent spellings of the
// same origin. The regex strips one trailing colon, not all of them, so
// 'https::' still fails the shape check rather than sneaking through.
function _cleanScheme(value) {
  if (typeof value !== 'string') return null;
  const scheme = value.trim().toLowerCase().replace(/:$/, '');
  return SCHEME.test(scheme) ? scheme : null;
}

function _cleanHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (!host) return null;
  return HOSTNAME.test(host) || IPV6.test(host) ? host : null;
}

function _cleanPort(value, scheme) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!DIGITS.test(raw)) return null;
  const port = Number(raw);
  if (port < 1 || port > 65535) return null;
  if (DEFAULT_PORTS[scheme] === port) return null;
  return port;
}

module.exports = { resolveBaseUrl };
