'use strict';

const { SENSITIVE_HEADERS, withoutSensitiveHeaders } = require('../src/sensitive-headers');

describe('SENSITIVE_HEADERS (sc-1470)', () => {
  test('names the credential and cookie headers, lower-cased', () => {
    expect([...SENSITIVE_HEADERS].sort()).toEqual(
      ['authorization', 'cookie', 'proxy-authorization', 'set-cookie'],
    );
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
