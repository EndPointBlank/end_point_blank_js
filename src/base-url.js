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
 *
 * A forwarded header counts as evidence only once its last hop parses to a
 * value that is actually usable for that field (a real scheme shape for
 * X-Forwarded-Proto, a real port number for X-Forwarded-Port). A blank,
 * whitespace-only or malformed header is treated exactly as if it had never
 * been sent — an unauthenticated caller sending `X-Forwarded-Port:
 * not-a-port` must not be able to blank out an otherwise-resolvable scheme or
 * port.
 *
 * X-Forwarded-Host does not, by itself, mark a request as proxied for scheme
 * or port purposes. `host` has always been directly caller-controlled — it
 * comes straight off the `Host` header even with no proxy in front at all —
 * so its presence proves nothing about whether the connection's own scheme
 * and port are still trustworthy. Only a validated X-Forwarded-Proto or
 * X-Forwarded-Port, evidence that specifically speaks to scheme/port,
 * distrusts the connection's own scheme/port.
 */

const HOSTNAME = /^[a-z0-9._-]+$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;
const DIGITS = /^[0-9]+$/;
const DEFAULT_PORTS = { http: 80, https: 443 };
// DNS's own ceiling. Nothing upstream validates X-Forwarded-Host, so a caller
// can hand a service an arbitrarily long one; the receiving column is
// varchar(255), and one oversized value there costs the whole co-batched
// flush. Every character this module accepts as a host is single-byte ASCII
// (see HOSTNAME/IPV6 above), so .length here is also the byte count.
const MAX_HOST_LENGTH = 253;

/**
 * @param {object} req
 * @param {{trustProxyHeaders?: boolean}} [options] when `trustProxyHeaders` is
 *   false the three X-Forwarded-* headers are not read at all, so the request is
 *   never treated as proxied and the connection's scheme and port stay evidence.
 * @returns {{scheme?: string, host?: string, port?: number}} only the fields
 *   that resolved. An unresolvable field is absent, never null — the receiver
 *   has to be able to tell "not reported" from "reported as nothing". `port`
 *   is never reported unless `scheme` also resolved: whether a port is the
 *   scheme's default is undefined when the scheme itself is unknown, and an
 *   unclassifiable port is worse than none at all.
 */
function resolveBaseUrl(req, { trustProxyHeaders = true } = {}) {
  if (!req) return {};
  const headers = req.headers || {};

  // forwardedScheme and forwardedPort are already validated here — a header
  // that fails to parse collapses to null and is indistinguishable, for every
  // later use in this function, from a header that was never sent.
  const forwardedScheme = trustProxyHeaders ? _cleanScheme(_lastHop(headers['x-forwarded-proto'])) : null;
  const forwardedHost = trustProxyHeaders ? _lastHop(headers['x-forwarded-host']) : null;
  const forwardedPort = trustProxyHeaders ? _cleanPort(_lastHop(headers['x-forwarded-port']), null) : null;

  // X-Forwarded-Host deliberately does not participate: see the module docs
  // above. Only validated scheme/port evidence distrusts the connection's own
  // scheme/port; a forwarded host is only ever data.
  const proxied = forwardedScheme !== null || forwardedPort !== null;

  const [hostPart, authorityPort] = _splitAuthority(
    forwardedHost || headers.host || req.hostname || req.host
  );

  const scheme = forwardedScheme || (proxied ? null : _cleanScheme(_connectionScheme(req)));
  const host = _cleanHost(hostPart);
  const port = scheme
    ? _cleanPort(forwardedPort || authorityPort || (proxied ? null : _connectionPort(req)), scheme)
    : null;

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
  // Drop, don't truncate: a truncated hostname is a plausible-looking wrong
  // value, and this is read verbatim to assemble a base URL downstream.
  if (host.length > MAX_HOST_LENGTH) return null;
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
