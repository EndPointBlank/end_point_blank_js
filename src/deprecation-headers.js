'use strict';

/**
 * Formats the deprecation facts returned by an authorize call into the
 * standard response headers.
 *
 * - `Deprecation` — RFC 9745, an Item Structured Header Date: `@1688169599`
 * - `Sunset` — RFC 8594, an HTTP-date: `Sat, 31 Dec 2018 23:59:59 GMT`
 *
 * RFC 9745 permits a past value ("was deprecated at that date"), which is what
 * EndPointBlank emits: deprecation takes effect when it is declared.
 *
 * Pure and stateless on purpose. The SDK does not know what a lifecycle is — it
 * relays two timestamps the portal already decided about, and this turns them
 * into two strings. That keeps the shared vectors assertable without
 * constructing a request.
 *
 * @module deprecation-headers
 */

const DEPRECATION = 'Deprecation';
const SUNSET = 'Sunset';

// Fixed English abbreviations. `toUTCString()` happens to produce this format,
// but spelling it out removes any dependence on a runtime's locale handling —
// an HTTP-date is the same in every locale.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parses a timestamp, returning `null` for anything unusable.
 *
 * Types are matched rather than coerced. `new Date(12345)` is a valid date in
 * 1970, so accepting a number would turn a nonsense value into a
 * plausible-looking header — the one outcome worse than no header at all.
 *
 * @param {*} value
 * @returns {Date|null}
 */
function parse(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string' || value === '') return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `@1688169599` — no quotes, no sub-second precision.
 *
 * @param {Date} date
 * @returns {string}
 */
function deprecationValue(date) {
  return `@${Math.floor(date.getTime() / 1000)}`;
}

/**
 * `Sat, 31 Dec 2018 23:59:59 GMT` — day-of-month zero padded, always GMT.
 *
 * @param {Date} date
 * @returns {string}
 */
function sunsetValue(date) {
  const pad = n => String(n).padStart(2, '0');

  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} GMT`
  );
}

/**
 * Builds the headers for a deprecation block.
 *
 * @param {object|null|undefined} deprecation - `{deprecated_at, sunset_at}` from
 *   the authorize response, or nothing.
 * @returns {Object<string,string>} header name to value; empty when there is
 *   nothing to say.
 */
function build(deprecation) {
  if (!deprecation || typeof deprecation !== 'object' || Array.isArray(deprecation)) return {};

  const headers = {};

  const deprecatedAt = parse(deprecation.deprecated_at ?? deprecation.deprecatedAt);
  if (deprecatedAt) headers[DEPRECATION] = deprecationValue(deprecatedAt);

  const sunsetAt = parse(deprecation.sunset_at ?? deprecation.sunsetAt);
  if (sunsetAt) headers[SUNSET] = sunsetValue(sunsetAt);

  return headers;
}

/**
 * Sets the headers on a response, if there are any.
 *
 * Never throws into the provider's response path: a malformed timestamp is a
 * bug worth no header, not a 500 on a request that already succeeded. Headers
 * already sent are left alone rather than raising `ERR_HTTP_HEADERS_SENT`.
 *
 * @param {import('http').ServerResponse} res
 * @param {object|null|undefined} deprecation
 */
function apply(res, deprecation) {
  try {
    if (!res || typeof res.setHeader !== 'function' || res.headersSent) return;

    for (const [name, value] of Object.entries(build(deprecation))) {
      res.setHeader(name, value);
    }
  } catch (err) {
    console.error('[EndPointBlank] Failed to set deprecation headers:', err.message);
  }
}

module.exports = { DeprecationHeaders: { build, apply } };
