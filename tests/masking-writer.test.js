'use strict';

const { applyMasking } = require('../src/masking');
const { instance: config } = require('../src/configuration');

describe('writer masking integration', () => {
  afterEach(() => { config.maskingRules = []; config.maskHook = null; });

  test('masks request body using configured rules (writer emits wire key "request")', () => {
    config.maskingRules = [
      { target: 'request_body', path: '$.email', regex: null, replacement_value: '...' },
    ];
    const out = applyMasking({ request: '{"email":"a@b.com"}' }, 'request', config.maskingRules, config.maskHook);
    expect(JSON.parse(out.request)).toEqual({ email: '...' });
  });

  test('writers still emit the real wire keys (headers/request/path/body/message)', () => {
    config.maskingRules = [
      { target: 'request_headers', path: '$.Authorization', regex: null, replacement_value: '...' },
    ];
    const out = applyMasking(
      { headers: { Authorization: 'Bearer x' }, request: '{}', path: '/p' },
      'request',
      config.maskingRules,
      config.maskHook,
    );
    expect(out).toHaveProperty('headers');
    expect(out).toHaveProperty('request');
    expect(out).toHaveProperty('path');
    expect(out.headers).toEqual({ Authorization: '...' });
  });
});
