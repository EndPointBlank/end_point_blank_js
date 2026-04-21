'use strict';

const DEFAULT_LIMIT = 1000;
const DEFAULT_SUFFIX = '<truncated>';

/**
 * Byte-aware string truncator that preserves valid UTF-8 sequences.
 *
 * Equivalent to the Ruby gem's `StringTruncator`.
 */
const StringTruncator = {
  /**
   * Truncates `str` so that its UTF-8 byte length does not exceed `limit`.
   * Appends `suffix` when truncation occurs. Always returns a string.
   *
   * @param {string|null|undefined} str
   * @param {object} [opts]
   * @param {number} [opts.limit=1000]
   * @param {string} [opts.suffix='<truncated>']
   * @returns {string}
   */
  truncate(str, { limit = DEFAULT_LIMIT, suffix = DEFAULT_SUFFIX } = {}) {
    if (str == null) return '';
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= limit) return str;

    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    const maxBytes = limit - suffixBytes;

    // Find the last valid UTF-8 character boundary at or before maxBytes.
    // Walk back past any UTF-8 continuation bytes (0x80–0xBF).
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xC0) === 0x80) {
      end--;
    }
    // If the lead byte at `end` starts a multi-byte sequence that extends past
    // maxBytes, exclude it entirely.
    const lead = buf[end];
    let charLen;
    if ((lead & 0x80) === 0x00) charLen = 1;
    else if ((lead & 0xE0) === 0xC0) charLen = 2;
    else if ((lead & 0xF0) === 0xE0) charLen = 3;
    else if ((lead & 0xF8) === 0xF0) charLen = 4;
    else charLen = 1;

    if (end + charLen > maxBytes) {
      // Incomplete char — exclude it
      end = end;  // already pointing at start of incomplete char; don't include it
    } else {
      end = maxBytes;
    }

    return buf.subarray(0, end).toString('utf8') + suffix;
  },
};

module.exports = { StringTruncator };
