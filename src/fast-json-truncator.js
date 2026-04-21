'use strict';

const MAX_BYTES  = 10000;
const MAX_DEPTH  = 5;
const MAX_LIST   = 20;
const MAX_STRING = 200;
const MAX_KEYS   = 20;

/**
 * Recursively prunes a JSON-serialisable value so it fits within a byte budget,
 * then serialises it to a JSON string.
 *
 * Equivalent to the Ruby gem's `FastJsonTruncator`.
 */
const FastJsonTruncator = {
  /**
   * @param {*} data - Any JSON-serialisable value.
   * @param {number} [limit=10000] - Maximum byte length of the resulting JSON string.
   * @returns {string}
   */
  truncate(data, limit = MAX_BYTES) {
    const pruned = prune(data, 0);
    const json = JSON.stringify(pruned);
    return ensureLimit(json, limit);
  },
};

function prune(value, depth) {
  if (depth > MAX_DEPTH) return '[truncated]';

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST).map(v => prune(v, depth + 1));
  }

  if (typeof value === 'object') {
    const result = {};
    let count = 0;
    for (const [k, v] of Object.entries(value)) {
      if (count >= MAX_KEYS) break;
      result[k] = prune(v, depth + 1);
      count++;
    }
    return result;
  }

  if (typeof value === 'string') {
    const buf = Buffer.from(value, 'utf8');
    if (buf.length > MAX_STRING) {
      return buf.subarray(0, MAX_STRING).toString('utf8') + '...';
    }
    return value;
  }

  return value;
}

function ensureLimit(json, limit) {
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= limit) return json;
  const sliced = Buffer.from(json, 'utf8').subarray(0, limit - 20).toString('utf8');
  return sliced + '...,"truncated":true}';
}

module.exports = { FastJsonTruncator };
