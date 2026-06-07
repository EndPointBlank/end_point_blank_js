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

function applyMasking(payload, recordType, rules, hook) {
  const masked = (rules || []).reduce((acc, rule) => applyRule(acc, recordType, rule), payload);
  return typeof hook === 'function' ? hook(masked, recordType) : masked;
}

function applyRule(payload, recordType, rule) {
  const fieldMap = FIELD_MAP[recordType] || {};
  return (rule.targets || []).reduce((acc, target) => {
    const key = fieldMap[target];
    if (!key || !(key in acc) || acc[key] == null) return acc;
    return { ...acc, [key]: maskValue(acc[key], rule) };
  }, payload);
}

function maskValue(value, rule) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return maskHeaders(value, rule);
  if (typeof value === 'string') return maskString(value, rule);
  return value;
}

function maskHeaders(headers, rule) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (rule.match_type === 'key' && k.toLowerCase() === rule.match_value.toLowerCase()) {
      out[k] = rule.mask_value;
    } else if (rule.match_type === 'regex' && typeof v === 'string') {
      out[k] = v.replace(new RegExp(rule.match_value, 'g'), rule.mask_value);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskString(value, rule) {
  if (rule.match_type === 'regex') {
    return value.replace(new RegExp(rule.match_value, 'g'), rule.mask_value);
  }
  try {
    return JSON.stringify(maskJson(JSON.parse(value), rule.match_value, rule.mask_value));
  } catch {
    return value;
  }
}

function maskJson(data, matchValue, mask) {
  if (Array.isArray(data)) return data.map((e) => maskJson(e, matchValue, mask));
  if (data && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = k.toLowerCase() === matchValue.toLowerCase() ? mask : maskJson(v, matchValue, mask);
    }
    return out;
  }
  return data;
}

module.exports = { applyMasking, FIELD_MAP };
