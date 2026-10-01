'use strict';

/**
 * The part of a caller's URL the SDK may keep, send to intake, or log:
 * scheme, host (IPv6 in brackets), port when it is not the scheme's default,
 * and path. Userinfo, query and fragment are removed (sc-1469).
 *
 * The caller controls the URL passed to `Authorization.header(url)`, and any
 * of those three parts can carry a secret. Intake needs none of them -- its
 * base-URL normalizer refuses a URL carrying any of them, even an empty `?`
 * or `#`, and answers 422 -- so sending them would both leak them and
 * guarantee the mint fails. Built from the parsed parts rather than by
 * splitting the string, so an empty `?` or `#` cannot slip through.
 *
 * Parsed with WHATWG `URL`, which lowercases the scheme and host, drops the
 * scheme's default port (`:443` for https, `:80` for http) and an empty
 * port, and refuses a non-numeric port or one above 65535; port 0 is
 * refused here. The Ruby gem's `TargetUrl.strip` does the same since
 * rails#43. One difference remains: `URL` percent-encodes the path and
 * resolves `.`/`..` segments in it (`/a/../b` is kept as `/b`), where Ruby
 * keeps the path as written. The Python, Java and Elixir SDKs have the same
 * helper.
 *
 * @param {*} value the URL as the caller passed it.
 * @returns {string|null} the stripped URL, or `null` when `value` is not a
 *   string, does not parse, is not an http or https URL, has no host, or
 *   has port 0. A `null` answer means
 *   no request may be made for it.
 */
function stripUrl(value) {
  if (typeof value !== 'string' || value === '') return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Only http and https: intake registers nothing else, and a mint for any
  // other scheme (ftp, ws, file, ...) is a request it can only refuse. The
  // Ruby gem's TargetUrl.strip refuses them the same way (rails#43).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  // `URL` already refuses a port above 65535 or a non-numeric one, but
  // accepts 0, which no request can be sent to.
  if (url.port !== '' && Number(url.port) < 1) return null;

  return `${url.protocol}//${url.host}${pathOf(url, value)}`;
}

/**
 * The parsed path, except that the parser answers "/" for a URL written with
 * no path at all (`https://h`, `https://h?x`); that is reported as the empty
 * path the caller actually wrote, not a slash they never sent.
 */
function pathOf(url, raw) {
  if (url.pathname !== '/') return url.pathname;
  return /^[^:]*:\/\/[^/?#]*\//.test(raw.trim()) ? '/' : '';
}

module.exports = { stripUrl };
