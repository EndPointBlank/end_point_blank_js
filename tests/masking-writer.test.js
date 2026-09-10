'use strict';

/**
 * Actual "writer masking integration": drives `RequestWriter` end-to-end and
 * asserts on what was posted over HTTP.
 *
 * This file used to call `applyMasking` directly on a hand-built object with
 * no writer involved — exactly the antipattern `tests/writers/*-writer.test.js`
 * and `tests/masking-builder-and-writer.test.js` warn against: asserting on an
 * intermediate object proves nothing about what actually reaches the network.
 * `tests/masking.test.js` already covers the masking engine itself in
 * isolation (that is its explicit purpose); this file exists to prove the
 * engine is wired into a real writer's send path. See sc-382.
 */

jest.mock('../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../src/commands/_http');
const { instance: config } = require('../src/configuration');
const { RequestWriter } = require('../src/writers/request-writer');

describe('writer masking integration', () => {
  const sentPayload = () => post.mock.calls[0][2].payload[0];

  const req = (overrides = {}) => ({
    headers: { 'content-type': 'application/json', ...overrides.headers },
    method: 'POST',
    path: '/v1/students',
    ...overrides,
  });

  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.logBaseUrl = 'https://log.epb.test';
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  test('masks the request body using configured rules, in what was actually posted', async () => {
    config.maskingRules = [
      { target: 'request_body', path: '$.email', regex: null, replacement_value: '...' },
    ];

    await RequestWriter.write(req({ body: { email: 'a@b.com' } }));

    expect(JSON.parse(sentPayload().request)).toEqual({ email: '...' });
  });

  test('the posted record still carries the real wire keys (headers/request/path)', async () => {
    config.maskingRules = [
      { target: 'request_headers', path: '$.authorization', regex: null, replacement_value: '...' },
    ];

    await RequestWriter.write(req({ headers: { authorization: 'Bearer x' }, body: {} }));

    const payload = sentPayload();
    expect(payload).toHaveProperty('headers');
    expect(payload).toHaveProperty('request');
    expect(payload).toHaveProperty('path');
    expect(payload.headers.authorization).toBe('...');
  });
});
