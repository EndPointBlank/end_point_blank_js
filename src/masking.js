'use strict';

// FIELD_MAP maps a masking target to the OUTGOING WIRE payload key (what the
// writers send and intake ingests). These MUST match intake's ingest keys:
// requests carry "headers"/"request"/"path", responses carry "body", errors "message".
const FIELD_MAP = {
  request: { request_body: 'request', request_headers: 'headers', path: 'path' },
  response: { response_body: 'body' },
  error: { error_message: 'message' },
  log: {},
};

// Targets whose wire value is a JSON string body (decode/apply/re-encode).
const JSON_TARGETS = ['request_body', 'response_body'];

// ---------------------------------------------------------------------------
// Constrained JSONPath subset — mirrors Intake.Masking.JsonPath exactly.
//
// Tokens:
//   $                                  — root
//   .name | ['name'] | ["name"]        — { child: name } (object key, case-sensitive)
//   [n]                                — { index: n } (0-based array index)
//   .* | [*]                           — { wildcard: true }
//   ..name                             — { descendant: name }
//
// parsePath returns an array of tokens, or null for unsupported/garbled input
// (caller treats null as "matches nothing"). Never throws.
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_]+/;

function parsePath(string) {
  if (typeof string !== 'string') return null;
  if (string[0] !== '$') return null;
  return parseTokens(string.slice(1), []);
}

function parseTokens(rest, acc) {
  if (rest === '') return acc;

  // Recursive descent: ..name
  if (rest.startsWith('..')) {
    const m = NAME_RE.exec(rest.slice(2));
    if (!m) return null;
    return parseTokens(rest.slice(2 + m[0].length), acc.concat([{ descendant: m[0] }]));
  }

  // Dot wildcard: .*
  if (rest.startsWith('.*')) {
    return parseTokens(rest.slice(2), acc.concat([{ wildcard: true }]));
  }

  // Dot child: .name
  if (rest.startsWith('.')) {
    const m = NAME_RE.exec(rest.slice(1));
    if (!m) return null;
    return parseTokens(rest.slice(1 + m[0].length), acc.concat([{ child: m[0] }]));
  }

  // Bracket forms
  if (rest.startsWith('[')) {
    const parsed = parseBracket(rest.slice(1));
    if (!parsed) return null;
    return parseTokens(parsed.remaining, acc.concat([parsed.token]));
  }

  return null;
}

function parseBracket(rest) {
  // Wildcard inside brackets: [*]
  if (rest.startsWith('*]')) {
    return { token: { wildcard: true }, remaining: rest.slice(2) };
  }
  // Quoted child names (single or double quotes); any chars between quotes.
  if (rest.startsWith("'")) return parseQuoted(rest.slice(1), "'");
  if (rest.startsWith('"')) return parseQuoted(rest.slice(1), '"');
  // Numeric index.
  const m = /^(\d+)\]/.exec(rest);
  if (m) {
    return { token: { index: parseInt(m[1], 10) }, remaining: rest.slice(m[0].length) };
  }
  return null;
}

function parseQuoted(rest, quoteChar) {
  const closing = quoteChar + ']';
  const idx = rest.indexOf(closing);
  if (idx === -1) return null;
  const name = rest.slice(0, idx);
  return { token: { child: name }, remaining: rest.slice(idx + closing.length) };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Walks `value` following `tokens`, replacing each fully-matched location with
// fn(oldValue) and rebuilding parents immutably. Never throws.
function transform(value, tokens, fn) {
  if (tokens == null) return value;
  if (tokens.length === 0) return fn(value);

  const [token, ...rest] = tokens;

  if (token.child !== undefined) {
    if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, token.child)) {
      return { ...value, [token.child]: transform(value[token.child], rest, fn) };
    }
    return value;
  }

  if (token.index !== undefined) {
    if (Array.isArray(value) && token.index >= 0 && token.index < value.length) {
      const out = value.slice();
      out[token.index] = transform(value[token.index], rest, fn);
      return out;
    }
    return value;
  }

  if (token.wildcard) {
    if (isPlainObject(value)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = transform(v, rest, fn);
      return out;
    }
    if (Array.isArray(value)) {
      return value.map((v) => transform(v, rest, fn));
    }
    return value;
  }

  if (token.descendant !== undefined) {
    return descend(value, token.descendant, rest, fn);
  }

  return value;
}

// Recursive descent: at this node and every nested node, any entry whose key is
// `key` matches the remaining tokens.
function descend(value, key, rest, fn) {
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const descended = descend(v, key, rest, fn);
      out[k] = k === key ? transform(descended, rest, fn) : descended;
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => descend(v, key, rest, fn));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Replacement backreferences (shared contract) — see spec
// "Replacement Backreferences". Implemented explicitly (NOT via native
// String.replace `$N`, which leaves out-of-range refs literal); here an
// out-of-range or non-participating group expands to "".
//
//   groups[0] = whole match, groups[n] = nth capture (undefined/missing → "").
//   $$           → literal "$"
//   $<digits>    → groups[N] ?? "" (the FULL consecutive digit run is one N)
//   $ + other    → literal "$" (also a trailing "$")
// ---------------------------------------------------------------------------

function expand(template, groups) {
  let out = '';
  let i = 0;
  const len = template.length;
  while (i < len) {
    const ch = template[i];
    if (ch !== '$') {
      out += ch;
      i += 1;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (next >= '0' && next <= '9') {
      let j = i + 1;
      while (j < len && template[j] >= '0' && template[j] <= '9') j += 1;
      const n = parseInt(template.slice(i + 1, j), 10);
      const g = n < groups.length ? groups[n] : undefined;
      out += g == null ? '' : g;
      i = j;
      continue;
    }
    // Lone "$" (followed by a non-digit/non-$, or end of string): literal.
    out += '$';
    i += 1;
  }
  return out;
}

// Global regex replacement using the explicit expander. Clones `regex` with the
// global flag, walks every match via matchAll, expands the template per match,
// and copies the gaps verbatim. Guards zero-width matches against infinite loop.
function regexReplaceAll(regex, str, template) {
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const re = new RegExp(regex.source, flags);
  let out = '';
  let last = 0;
  for (const m of str.matchAll(re)) {
    out += str.slice(last, m.index);
    out += expand(template, m);
    last = m.index + m[0].length;
    if (m[0] === '') {
      // Zero-width match: copy one char and advance so we don't loop forever.
      if (m.index < str.length) out += str[m.index];
      last = m.index + 1;
      re.lastIndex = m.index + 1;
    }
  }
  out += str.slice(last);
  return out;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function applyMasking(payload, recordType, rules, hook) {
  const masked = (rules || []).reduce((acc, rule) => applyRule(acc, recordType, rule), payload);
  return typeof hook === 'function' ? hook(masked, recordType) : masked;
}

function applyRule(payload, recordType, rule) {
  const fieldMap = FIELD_MAP[recordType] || {};
  const key = fieldMap[rule.target];
  if (!key || !(key in payload) || payload[key] == null) return payload;
  return { ...payload, [key]: maskField(payload[key], rule) };
}

function compiled(rule) {
  // Returns a precomputed { tokens, regexp, repl } context for the rule.
  const repl = rule.replacement_value == null || rule.replacement_value === '' ? '...' : rule.replacement_value;
  const tokens = rule.path != null && rule.path !== '' ? parsePath(rule.path) : null;
  let regexp = null;
  if (rule.regex != null && rule.regex !== '') {
    try {
      regexp = new RegExp(rule.regex, 'g');
    } catch {
      regexp = null;
    }
  }
  return { tokens, regexp, repl };
}

function maskField(value, rule) {
  const ctx = compiled(rule);

  // Body targets: JSON string. Decode, apply on the decoded value, re-encode.
  // On non-JSON: path no-ops; regex (if present) applies to the raw string.
  if (typeof value === 'string') {
    if (JSON_TARGETS.includes(rule.target)) {
      let decoded;
      try {
        decoded = JSON.parse(value);
      } catch {
        return applyToRawString(value, ctx);
      }
      return JSON.stringify(applyToValue(decoded, ctx));
    }
    // path / error_message: plain strings — path no-ops, only regex applies.
    return applyToRawString(value, ctx);
  }

  // request_headers: a map. Path applies to the map; regex applies to string leaves.
  if (isPlainObject(value)) {
    return applyToValue(value, ctx);
  }

  return value;
}

// A plain, non-JSON string target: path cannot apply (no-op); regex applies.
function applyToRawString(value, ctx) {
  if (ctx.regexp) return regexReplaceAll(ctx.regexp, value, ctx.repl);
  return value;
}

// Applies the rule to a structured value (decoded JSON or header map).
function applyToValue(value, ctx) {
  // path + regex: select nodes, apply regex to leaves within each.
  if (ctx.tokens != null && ctx.regexp) {
    return transform(value, ctx.tokens, (old) => regexReplaceLeaves(old, ctx.regexp, ctx.repl));
  }
  // path only: replace each selected node entirely.
  if (ctx.tokens != null) {
    return transform(value, ctx.tokens, () => ctx.repl);
  }
  // regex only: substitute across every string leaf.
  if (ctx.regexp) {
    return regexReplaceLeaves(value, ctx.regexp, ctx.repl);
  }
  // no usable path or regex: no-op.
  return value;
}

// Recurse over containers; substitute on every string leaf.
function regexReplaceLeaves(node, regexp, repl) {
  if (typeof node === 'string') return regexReplaceAll(regexp, node, repl);
  if (Array.isArray(node)) return node.map((v) => regexReplaceLeaves(v, regexp, repl));
  if (isPlainObject(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = regexReplaceLeaves(v, regexp, repl);
    return out;
  }
  return node;
}

module.exports = { applyMasking, FIELD_MAP, parsePath, transform, regexReplaceLeaves, expand, regexReplaceAll };
