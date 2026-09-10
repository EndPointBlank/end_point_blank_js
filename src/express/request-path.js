'use strict';

/**
 * The single place a request's endpoint path is decided.
 *
 * Three call sites name an endpoint — registration, authorization, and
 * authentication — and all three must produce byte-identical paths: intake
 * stores what it is told at registration and matches it exactly at authorize
 * time (`Intake.PathNormalizer` only rewrites `{var}` to `:var` — it does not
 * touch trailing slashes). A guard that resolves the path differently from
 * registration asks about an endpoint intake has never been told about, so
 * every request through it fails with `missing_target_endpoint` while both
 * halves look correct in isolation. Hence one function, used by all three.
 *
 * `authenticated` kept a transcription of its own until it was moved here — it
 * read `req.route?.path || req.path || req.url`, with no `req.baseUrl` and no
 * normalization, so a router mounted at `/whoami` authenticated as `/`.
 */

/**
 * Strips a trailing slash, except from the root path.
 *
 * Express composes an index route on a mounted router as `prefix + '/'`, so a
 * router mounted at `/books` with `router.get('/')` yields `/books/`. The Rails
 * SDK reports the same route as `/books`, so without this the two SDKs describe
 * one endpoint two ways and app_portal lists a path nobody calls.
 *
 * `/` is left alone: an empty string is not a path anything can match.
 *
 * @param {string} path
 * @returns {string}
 */
function normalizePath(path) {
  if (typeof path !== 'string' || path === '') return '/';
  if (path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The endpoint path for an incoming request, in the form it was registered.
 *
 * Prefers the route *pattern* (`/books/:id`) over the concrete URL (`/books/7`),
 * because that is what was registered.
 *
 * @param {object} req - Express `Request` or a shape carrying baseUrl/route/path/url.
 * @returns {string}
 */
function requestPath(req) {
  const base = req.baseUrl || '';
  const suffix = req.route?.path || req.path || req.url || '';
  return normalizePath(base + suffix);
}

module.exports = { normalizePath, requestPath };
