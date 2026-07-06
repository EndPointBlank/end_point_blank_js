'use strict';

const { post } = require('../../src/commands/_http');

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
