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

describe('applyMasking — regex replacement backreferences', () => {
  // Reference vectors from the shared contract spec.
  test('vector: $1-XX-XXXX', () => {
    const payload = { request: '123-45-6789' };
    const out = applyMasking(payload, 'request', [rule('request_body', { regex: '(\\d{3})-(\\d{2})-(\\d{4})', replacement_value: '$1-XX-XXXX' })], null);
    expect(out.request).toBe('123-XX-XXXX');
  });

  test('vector: credit card $1-****-****-$2 (regex-only, raw string)', () => {
    const payload = { request: '4111-1111-1111-1234' };
    const out = applyMasking(payload, 'request', [rule('request_body', { regex: '(\\d{4})-\\d{4}-\\d{4}-(\\d{4})', replacement_value: '$1-****-****-$2' })], null);
    expect(out.request).toBe('4111-****-****-1234');
  });

  test('vector: credit card $1-****-****-$2 (path + regex, $.card)', () => {
    const payload = { body: JSON.stringify({ card: '4111-1111-1111-1234' }) };
    const out = applyMasking(payload, 'response', [rule('response_body', { path: '$.card', regex: '(\\d{4})-\\d{4}-\\d{4}-(\\d{4})', replacement_value: '$1-****-****-$2' })], null);
    expect(JSON.parse(out.body)).toEqual({ card: '4111-****-****-1234' });
  });

  test('vector: global multi-match ab1c2 → ab[1]c[2]', () => {
    const payload = { message: 'ab1c2' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: '(\\d)', replacement_value: '[$1]' })], null);
    expect(out.message).toBe('ab[1]c[2]');
  });

  test('vector: swap groups 12-34 → 34/12', () => {
    const payload = { message: '12-34' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: '(\\d+)-(\\d+)', replacement_value: '$2/$1' })], null);
    expect(out.message).toBe('34/12');
  });

  test('vector: out-of-range group $3 on no-such-group → empty', () => {
    const payload = { message: '42' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: '(\\d+)', replacement_value: '$3' })], null);
    expect(out.message).toBe('');
  });

  test('vector: no-group regex with $1 → empty', () => {
    const payload = { message: '42' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: '\\d+', replacement_value: '$1' })], null);
    expect(out.message).toBe('');
  });

  test('vector: $$ → literal dollar', () => {
    const payload = { message: '5' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: '\\d', replacement_value: '$$' })], null);
    expect(out.message).toBe('$');
  });

  test('lone $ not followed by digit or $ is literal', () => {
    const payload = { message: 'x5y' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: '\\d', replacement_value: 'a$b' })], null);
    expect(out.message).toBe('xa$by');
  });

  test('multi-digit group reference $12', () => {
    const payload = { message: 'abcdefghijklm' };
    const regex = '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)(m)';
    const out = applyMasking(payload, 'error', [rule('error_message', { regex, replacement_value: '<$12>' })], null);
    expect(out.message).toBe('<l>');
  });

  test('$0 is the whole match', () => {
    const payload = { message: 'foo' };
    const out = applyMasking(payload, 'error', [rule('error_message', { regex: 'foo', replacement_value: '[$0]' })], null);
    expect(out.message).toBe('[foo]');
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

describe('applyMasking — more of the JSONPath subset', () => {
  const maskBody = (body, path, replacement_value = '***') =>
    JSON.parse(
      applyMasking(
        { request: JSON.stringify(body) },
        'request',
        [rule('request_body', { path, replacement_value })],
        null,
      ).request,
    );

  test('$.creds.* masks every value under a key', () => {
    expect(maskBody({ creds: { user: 'ada', pass: 'hunter2' }, id: 1 }, '$.creds.*')).toEqual({
      creds: { user: '***', pass: '***' },
      id: 1,
    });
  });

  test('$.tokens.* masks every element of an array', () => {
    expect(maskBody({ tokens: ['a', 'b'] }, '$.tokens.*')).toEqual({ tokens: ['***', '***'] });
  });

  test('a wildcard over a scalar leaves it alone', () => {
    expect(maskBody({ note: 'plain' }, '$.note.*')).toEqual({ note: 'plain' });
  });

  test('$.items[1].secret masks one element by index', () => {
    expect(maskBody({ items: [{ secret: 'a' }, { secret: 'b' }] }, '$.items[1].secret')).toEqual({
      items: [{ secret: 'a' }, { secret: '***' }],
    });
  });

  test('$..token reaches into objects nested inside arrays', () => {
    // Collections of records are the normal shape of an API body, so a
    // recursive rule that stopped at the first array would miss almost
    // everything a customer wrote it for.
    expect(maskBody({ users: [{ token: 'a' }, { token: 'b' }] }, '$..token')).toEqual({
      users: [{ token: '***' }, { token: '***' }],
    });
  });

  test('$..token leaves scalars that share no key alone', () => {
    expect(maskBody({ count: 2, users: [{ token: 'a' }] }, '$..token')).toEqual({
      count: 2,
      users: [{ token: '***' }],
    });
  });

  test.each([
    ['a path not anchored at the root', 'user.ssn'],
    ['a path with a stray token', '$user'],
    ['an unterminated bracket', '$["user'],
    ['a trailing dot', '$.'],
    ['a bare recursive descent', '$..'],
    ['an empty bracket', '$[]'],
  ])('%s masks nothing rather than everything', (_label, path) => {
    // A path the SDK cannot parse must select nothing. Falling back to
    // "matches everything" would replace a customer's whole payload.
    expect(maskBody({ user: { ssn: '123-45-6789' } }, path)).toEqual({
      user: { ssn: '123-45-6789' },
    });
  });
});

describe('applyMasking — values that are not strings', () => {
  test('a regex rule leaves numbers and booleans as they are', () => {
    // Coercing a leaf to a string to run a regex over it would change the
    // type on the wire and break anything reading the field.
    const payload = { request: JSON.stringify({ amount: 42, ok: true, note: 'x1' }) };

    const out = applyMasking(
      payload,
      'request',
      [rule('request_body', { regex: '\\d', replacement_value: '#' })],
      null,
    );

    expect(JSON.parse(out.request)).toEqual({ amount: 42, ok: true, note: 'x#' });
  });

  test('a rule against a field that is not maskable leaves it untouched', () => {
    const payload = { request: 42 };

    const out = applyMasking(
      payload,
      'request',
      [rule('request_body', { path: '$.a', replacement_value: '#' })],
      null,
    );

    expect(out.request).toBe(42);
  });

  test('a rule against an absent field is a no-op', () => {
    const payload = { headers: { a: 'b' } };

    expect(applyMasking(payload, 'request', [rule('request_body')], null)).toBe(payload);
  });

  test('a rule against a null field is a no-op', () => {
    const payload = { request: null };

    expect(applyMasking(payload, 'request', [rule('request_body', { path: '$.a' })], null)).toBe(
      payload,
    );
  });
});

describe('applyMasking — regexes that match nothing in particular', () => {
  test('a pattern that can match the empty string still terminates', () => {
    // `x*` matches at every position, including zero-width. Advancing by zero
    // would spin forever and hang the request that triggered it.
    const payload = { message: 'abc' };

    const out = applyMasking(
      payload,
      'error',
      [rule('error_message', { regex: 'x*', replacement_value: '-' })],
      null,
    );

    expect(typeof out.message).toBe('string');
    expect(out.message.length).toBeLessThan(50);
  });

  test('a zero-width pattern loses none of the original characters', () => {
    // The guard against the infinite loop advances a character at a time; it
    // has to copy that character rather than skip it.
    const payload = { message: 'ab' };

    const out = applyMasking(
      payload,
      'error',
      [rule('error_message', { regex: '(?:)', replacement_value: '-' })],
      null,
    );

    expect(out.message.replace(/-/g, '')).toBe('ab');
  });
});
