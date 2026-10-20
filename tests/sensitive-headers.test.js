'use strict';

const { SENSITIVE_HEADERS, withoutSensitiveHeaders } = require('../src/sensitive-headers');

describe('SENSITIVE_HEADERS (sc-1470)', () => {
  test('names the credential, cookie, API key and token headers, lower-cased', () => {
    expect([...SENSITIVE_HEADERS].sort()).toEqual([
      'authorization',
      'proxy-authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'api-key',
      'x-auth-token',
      'x-access-token',
      'x-refresh-token',
      'x-amz-security-token',
      'x-csrf-token',
      'x-xsrf-token',
      'x-goog-api-key',
      'ocp-apim-subscription-key',
    ].sort());
  });

  test('cannot be changed at runtime', () => {
    expect(Object.isFrozen(SENSITIVE_HEADERS)).toBe(true);
  });
});

describe('withoutSensitiveHeaders', () => {
  test('drops every listed header whatever its case and keeps the rest', () => {
    expect(withoutSensitiveHeaders({
      Authorization: 'Basic x',
      'PROXY-AUTHORIZATION': 'Basic y',
      cookie: 'a=b',
      'Set-Cookie': 'c=d',
      'X-Authorization-Hint': 'kept',
      accept: 'application/json',
    })).toEqual({ 'X-Authorization-Hint': 'kept', accept: 'application/json' });
  });

  test('drops the API key and token headers whatever their case (sc-1626)', () => {
    expect(withoutSensitiveHeaders({
      'X-Api-Key': 'k1',
      'API-KEY': 'k2',
      'x-auth-token': 't1',
      'X-Access-Token': 't2',
      'X-Amz-Security-Token': 't3',
      'Ocp-Apim-Subscription-Key': 'k3',
      'X-Api-Version': '2',
    })).toEqual({ 'X-Api-Version': '2' });
  });

  test('returns a new map and leaves its argument alone', () => {
    const headers = { authorization: 'Basic x', accept: '*/*' };

    const kept = withoutSensitiveHeaders(headers);

    expect(kept).not.toBe(headers);
    expect(headers).toEqual({ authorization: 'Basic x', accept: '*/*' });
  });

  test('answers an empty map for a missing one', () => {
    expect(withoutSensitiveHeaders(undefined)).toEqual({});
    expect(withoutSensitiveHeaders(null)).toEqual({});
  });
});
