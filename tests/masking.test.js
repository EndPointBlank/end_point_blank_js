'use strict';

const { applyMasking } = require('../src/masking');

const keyRule = (v, targets, mask = '...') => ({ match_type: 'key', match_value: v, targets, mask_value: mask });
const regexRule = (s, targets, mask = '...') => ({ match_type: 'regex', match_value: s, targets, mask_value: mask });

describe('applyMasking', () => {
  test('masks a matching header value case-insensitively (wire key "headers")', () => {
    const payload = { headers: { Authorization: 'Bearer x', 'X-Trace': 'ok' } };
    const out = applyMasking(payload, 'request', [keyRule('authorization', ['request_headers'])], null);
    expect(out.headers).toEqual({ Authorization: '...', 'X-Trace': 'ok' });
  });

  test('masks a JSON response body (wire key "body")', () => {
    const payload = { body: '{"email":"a@b.com"}' };
    const out = applyMasking(payload, 'response', [keyRule('email', ['response_body'])], null);
    expect(JSON.parse(out.body)).toEqual({ email: '...' });
  });

  test('masks matching keys in a JSON request body at any depth', () => {
    const payload = { request: '{"user":{"email":"a@b.com"},"items":[{"email":"c@d.com"}]}' };
    const out = applyMasking(payload, 'request', [keyRule('email', ['request_body'], '[X]')], null);
    expect(JSON.parse(out.request)).toEqual({ user: { email: '[X]' }, items: [{ email: '[X]' }] });
  });

  test('leaves a non-JSON body unchanged for a key rule', () => {
    const payload = { request: 'not json a@b.com' };
    const out = applyMasking(payload, 'request', [keyRule('email', ['request_body'])], null);
    expect(out.request).toBe('not json a@b.com');
  });

  test('regex-masks the path substring', () => {
    const payload = { path: '/users/a@b.com/x' };
    const out = applyMasking(payload, 'request', [regexRule('[\\w.]+@[\\w.]+', ['path'])], null);
    expect(out.path).toBe('/users/.../x');
  });

  test('does not touch request fields for an error record', () => {
    const payload = { request: '{"email":"a@b.com"}' };
    const out = applyMasking(payload, 'error', [keyRule('email', ['request_body'])], null);
    expect(out.request).toBe('{"email":"a@b.com"}');
  });

  test('runs the hook after the rules', () => {
    const payload = { request: '{"email":"a@b.com"}' };
    const hook = (p) => ({ ...p, extra: 'added' });
    const out = applyMasking(payload, 'request', [keyRule('email', ['request_body'])], hook);
    expect(out.extra).toBe('added');
    expect(JSON.parse(out.request)).toEqual({ email: '...' });
  });
});
