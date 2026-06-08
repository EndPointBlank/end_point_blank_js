'use strict';

const { applyMasking } = require('../src/masking');

const rule = (target, { path = null, regex = null, replacement_value = '...' } = {}) => ({
  target,
  path,
  regex,
  replacement_value,
});

describe('applyMasking — JSONPath path-only', () => {
  test('$.user.ssn → ***', () => {
    const payload = { request: JSON.stringify({ user: { ssn: 'abc' } }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.user.ssn', replacement_value: '***' })], null);
    expect(JSON.parse(out.request)).toEqual({ user: { ssn: '***' } });
  });

  test('$..password masks all passwords at any depth', () => {
    const payload = { request: JSON.stringify({ a: { password: 1 }, b: { password: 2 } }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$..password', replacement_value: '***' })], null);
    expect(JSON.parse(out.request)).toEqual({ a: { password: '***' }, b: { password: '***' } });
  });

  test('$.list[*].k masks both array elements', () => {
    const payload = { request: JSON.stringify({ list: [{ k: 'p' }, { k: 'q' }] }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.list[*].k', replacement_value: '_' })], null);
    expect(JSON.parse(out.request)).toEqual({ list: [{ k: '_' }, { k: '_' }] });
  });

  test('path no-op on a non-JSON body', () => {
    const payload = { request: 'not json a@b.com' };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.email' })], null);
    expect(out.request).toBe('not json a@b.com');
  });

  test('path on a plain string target (URL path) is a no-op', () => {
    const payload = { path: '123-45-6789' };
    const out = applyMasking(payload, 'request', [rule('path', { path: '$.x', replacement_value: '_' })], null);
    expect(out.path).toBe('123-45-6789');
  });

  test('missing child / out-of-range index / wrong type are no-ops', () => {
    const payload = { request: JSON.stringify({ a: 1 }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.missing.deep', replacement_value: 'X' })], null);
    expect(JSON.parse(out.request)).toEqual({ a: 1 });

    const payload2 = { request: JSON.stringify({ list: [{ k: 'p' }] }) };
    const out2 = applyMasking(payload2, 'request', [rule('request_body', { path: '$.list[5].k', replacement_value: 'X' })], null);
    expect(JSON.parse(out2.request)).toEqual({ list: [{ k: 'p' }] });
  });

  test('bracket and quoted child forms', () => {
    const payload = { request: JSON.stringify({ 'a.b': { c: 'x' } }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: "$['a.b'].c", replacement_value: 'Y' })], null);
    expect(JSON.parse(out.request)).toEqual({ 'a.b': { c: 'Y' } });
  });
});

describe('applyMasking — regex-only', () => {
  test('global substitution on every string leaf; non-matching leaves untouched', () => {
    const payload = { request: JSON.stringify({ a: 'x 123-45-6789', b: 'y' }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { regex: '\\d{3}-\\d{2}-\\d{4}', replacement_value: 'XXX' })], null);
    expect(JSON.parse(out.request)).toEqual({ a: 'x XXX', b: 'y' });
  });

  test('regex-masks the path substring (plain string target)', () => {
    const payload = { path: '/users/a@b.com/x' };
    const out = applyMasking(payload, 'request', [rule('path', { regex: '[\\w.]+@[\\w.]+' })], null);
    expect(out.path).toBe('/users/.../x');
  });

  test('regex applies to a non-JSON body raw string', () => {
    const payload = { request: 'ssn 123-45-6789 here' };
    const out = applyMasking(payload, 'request', [rule('request_body', { regex: '\\d{3}-\\d{2}-\\d{4}', replacement_value: 'XXX' })], null);
    expect(out.request).toBe('ssn XXX here');
  });

  test('regex replaces all matches globally', () => {
    const payload = { request: JSON.stringify({ a: '1-1 2-2' }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { regex: '\\d-\\d', replacement_value: '#' })], null);
    expect(JSON.parse(out.request)).toEqual({ a: '# #' });
  });
});

describe('applyMasking — path + regex (scoped)', () => {
  test('$.note + \\d{3}-\\d{2}-\\d{4} scoped to note only', () => {
    const payload = { request: JSON.stringify({ note: 'ssn 123-45-6789', other: '123-45-6789' }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.note', regex: '\\d{3}-\\d{2}-\\d{4}', replacement_value: 'XXX' })], null);
    expect(JSON.parse(out.request)).toEqual({ note: 'ssn XXX', other: '123-45-6789' });
  });

  test('path selecting a container applies regex to leaves within it', () => {
    const payload = { request: JSON.stringify({ inner: { a: '111', b: '222' }, outer: '333' }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.inner', regex: '\\d+', replacement_value: '#' })], null);
    expect(JSON.parse(out.request)).toEqual({ inner: { a: '#', b: '#' }, outer: '333' });
  });
});

describe('applyMasking — headers target', () => {
  test('path selects a header value and replaces it entirely', () => {
    const payload = { headers: { Authorization: 'Bearer x', 'X-Trace': 'ok' } };
    const out = applyMasking(payload, 'request', [rule('request_headers', { path: '$.Authorization' })], null);
    expect(out.headers).toEqual({ Authorization: '...', 'X-Trace': 'ok' });
  });

  test('regex applies to every string header value', () => {
    const payload = { headers: { A: 'has 123-45-6789', B: 'clean' } };
    const out = applyMasking(payload, 'request', [rule('request_headers', { regex: '\\d{3}-\\d{2}-\\d{4}', replacement_value: 'XXX' })], null);
    expect(out.headers).toEqual({ A: 'has XXX', B: 'clean' });
  });
});

describe('applyMasking — targets / record types', () => {
  test('masks a JSON response body (wire key "body")', () => {
    const payload = { body: JSON.stringify({ email: 'a@b.com' }) };
    const out = applyMasking(payload, 'response', [rule('response_body', { path: '$.email' })], null);
    expect(JSON.parse(out.body)).toEqual({ email: '...' });
  });

  test('masks an error message (wire key "message") via regex', () => {
    const payload = { message: 'failed for 123-45-6789' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: '\\d{3}-\\d{2}-\\d{4}', replacement_value: 'XXX' })], null);
    expect(out.message).toBe('failed for XXX');
  });

  test('does not touch request fields for an error record', () => {
    const payload = { request: '{"email":"a@b.com"}' };
    const out = applyMasking(payload, 'error', [rule('request_body', { path: '$.email' })], null);
    expect(out.request).toBe('{"email":"a@b.com"}');
  });
});

describe('applyMasking — robustness', () => {
  test('rule with neither path nor regex is a no-op', () => {
    const payload = { request: JSON.stringify({ a: 1 }) };
    const out = applyMasking(payload, 'request', [rule('request_body', {})], null);
    expect(JSON.parse(out.request)).toEqual({ a: 1 });
  });

  test('malformed path never throws and is a no-op', () => {
    const payload = { request: JSON.stringify({ a: 1 }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$[?(@.a)]', replacement_value: 'X' })], null);
    expect(JSON.parse(out.request)).toEqual({ a: 1 });
  });

  test('invalid regex never throws and is a no-op', () => {
    const payload = { request: JSON.stringify({ a: 'x' }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { regex: '(' , replacement_value: 'X' })], null);
    expect(JSON.parse(out.request)).toEqual({ a: 'x' });
  });

  test('runs the hook after the rules', () => {
    const payload = { request: JSON.stringify({ email: 'a@b.com' }) };
    const hook = (p) => ({ ...p, extra: 'added' });
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.email' })], hook);
    expect(out.extra).toBe('added');
    expect(JSON.parse(out.request)).toEqual({ email: '...' });
  });

  test('handles null rules list', () => {
    const payload = { request: '{"a":1}' };
    expect(applyMasking(payload, 'request', null, null)).toBe(payload);
  });

  test('blank replacement_value coerces to "..."', () => {
    const payload = { request: JSON.stringify({ a: 'x' }) };
    const out = applyMasking(payload, 'request', [rule('request_body', { path: '$.a', replacement_value: '' })], null);
    expect(JSON.parse(out.request)).toEqual({ a: '...' });
  });
});
