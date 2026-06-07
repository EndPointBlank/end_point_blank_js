'use strict';

const { applyMasking } = require('../src/masking');
const { instance: config } = require('../src/configuration');

describe('writer masking integration', () => {
  afterEach(() => { config.maskingRules = []; config.maskHook = null; });

  test('masks request body using configured rules', () => {
    config.maskingRules = [{ match_type: 'key', match_value: 'email', targets: ['request_body'], mask_value: '...' }];
    const out = applyMasking({ request: '{"email":"a@b.com"}' }, 'request', config.maskingRules, config.maskHook);
    expect(JSON.parse(out.request)).toEqual({ email: '...' });
  });
});
