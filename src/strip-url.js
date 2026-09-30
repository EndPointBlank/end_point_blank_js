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
 * The same helper, with the same behaviour, exists in the Python, Java,
 * Elixir and Ruby SDKs.
 *
 * @param {*} value the URL as the caller passed it.
 * @returns {string|null} the stripped URL, or `null` when `value` is not a
 *   string, does not parse, or has no scheme or host. A `null` answer means
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
  if (!url.protocol || !url.hostname) return null;

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
