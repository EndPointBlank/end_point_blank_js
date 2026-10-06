'use strict';

/**
 * Headers the SDK never sends to intake, in any letter case.
 *
 * A request record used to carry every inbound header, so a caller's
 * `Authorization: Basic client_id:secret` or bearer token, a proxy credential
 * and its session cookie landed in the provider's request log unless the
 * provider had written a masking rule for them. A response record likewise
 * carried `Set-Cookie`. These are dropped from the record before masking runs,
 * not masked, so no rule and no `maskHook` can bring them back. See sc-1470.
 *
 * One list serves both records: `Set-Cookie` never arrives on a request and
 * the other three are not response headers, so each record only ever loses
 * what the story names for it.
 */
const SENSITIVE_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/**
 * Returns a copy of `headers` without any of {@link SENSITIVE_HEADERS}.
 * Never mutates its argument; a missing or non-object map is `{}`.
 *
 * @param {object} [headers]
 * @returns {object}
 */
function withoutSensitiveHeaders(headers) {
  const kept = {};
  if (!headers || typeof headers !== 'object') return kept;
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.includes(String(name).toLowerCase())) kept[name] = value;
  }
  return kept;
}

module.exports = { SENSITIVE_HEADERS, withoutSensitiveHeaders };
