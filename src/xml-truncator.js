'use strict';

const { StringTruncator } = require('./string-truncator');

const MAX_BYTES = 10000;

/**
 * Truncates an XML string to fit within a byte budget.
 *
 * Node.js has no built-in XML DOM, so this implementation falls back to
 * byte-level string truncation with a `<truncated/>` suffix when the input
 * exceeds the limit.
 *
 * Equivalent to the Ruby gem's `XmlTruncator`.
 */
const XmlTruncator = {
  /**
   * @param {string|null|undefined} xml
   * @param {object} [opts]
   * @param {number} [opts.limit=10000]
   * @returns {string}
   */
  truncate(xml, { limit = MAX_BYTES } = {}) {
    const input = xml == null ? '' : String(xml);
    if (input.length === 0) return '';
    if (Buffer.byteLength(input, 'utf8') <= limit) return input;

    return StringTruncator.truncate(input, { limit, suffix: '<truncated/>' });
  },
};

module.exports = { XmlTruncator };
