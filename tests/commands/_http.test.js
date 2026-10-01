'use strict';

const { post, isNetworkError } = require('../../src/commands/_http');

describe('_http post timeout', () => {
  let originalFetch;
  let setTimeoutSpy;

  beforeEach(() => {
    originalFetch = global.fetch;
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setTimeoutSpy.mockRestore();
  });

  test('arms a single-attempt abort timer of 8000ms (tightened from the old 15000ms)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200 });

    await post('https://example.test/x', 'Bearer t', { a: 1 });

    const delays = setTimeoutSpy.mock.calls.map(call => call[1]);
    expect(delays).toContain(8000);
    expect(delays).not.toContain(15000);
  });

  test('passes an AbortSignal to fetch so a slow response can be aborted', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200 });

    await post('https://example.test/x', 'Bearer t', { a: 1 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test('gracefully returns null (does not throw) when fetch aborts due to timeout', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));

    const resultPromise = post('https://example.test/x', 'Bearer t', { a: 1 });
    // 3 attempts x 8000ms abort timer + 2 x 200ms inter-attempt retry delay.
    await jest.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS retries, all time out
    jest.useRealTimers();
  });
});

describe('_http post: only a network error is retried (sc-1469)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('a connection failure is retried, then answered null', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(post('https://example.test/x', 'Bearer t', {})).resolves.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('anything else is thrown on the first attempt, as itself', async () => {
    const bug = new TypeError('Failed to parse URL from nope');
    global.fetch = jest.fn().mockRejectedValue(bug);

    await expect(post('nope', 'Bearer t', {})).rejects.toBe(bug);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a body that cannot be serialized is thrown before any request', async () => {
    global.fetch = jest.fn();
    const body = {};
    body.self = body;

    await expect(post('https://example.test/x', 'Bearer t', body)).rejects.toThrow(TypeError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['our own timeout', Object.assign(new Error('aborted'), { name: 'AbortError' }), true],
    ['a TimeoutError', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), true],
    ["fetch's connection failure", new TypeError('fetch failed'), true],
    ['a bare socket error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }), true],
    ['an undici error', Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }), true],
    ['an unparseable URL', new TypeError('Failed to parse URL from nope'), false],
    ['an invalid-URL code', Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }), false],
    ['a plain bug', new Error('undefined is not a function'), false],
    ['a non-error', 'boom', false],
  ])('isNetworkError: %s', (_label, err, expected) => {
    expect(isNetworkError(err)).toBe(expected);
  });
});
