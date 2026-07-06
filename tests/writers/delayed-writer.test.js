'use strict';

const { DelayedWriter } = require('../../src/writers/delayed-writer');
const { DirectWriter } = require('../../src/writers/direct-writer');

jest.mock('../../src/writers/direct-writer');

describe('DelayedWriter bounded queue', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Keep the background flush from racing the assertions below: make every
    // flushed batch hang until the test explicitly wants it to resolve.
    DirectWriter.mockImplementation(() => ({
      write: jest.fn(() => new Promise(() => {})),
    }));
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.clearAllMocks();
  });

  test('caps the queue at 1000 items, dropping the oldest first', () => {
    const writer = new DelayedWriter('logUrl');

    // Enqueue one at a time so we exercise the drop path repeatedly rather
    // than a single oversized batch.
    for (let i = 0; i < 1500; i++) {
      writer.write([{ id: i }]);
    }

    expect(writer._queue.length).toBe(1000);
    // Oldest entries (0..499) should have been dropped; the newest 1000
    // survive (500..1499).
    expect(writer._queue[0]).toEqual({ id: 500 });
    expect(writer._queue[writer._queue.length - 1]).toEqual({ id: 1499 });
  });

  test('logs a warning when items are dropped', () => {
    const writer = new DelayedWriter('logUrl');

    for (let i = 0; i < 1001; i++) {
      writer.write([{ id: i }]);
    }

    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/dropp?ing|queue full|overflow/i);
  });

  test('throttles the drop warning instead of logging on every single drop', () => {
    const writer = new DelayedWriter('logUrl');

    // Overflow the queue by a lot of individual pushes (many drop events).
    for (let i = 0; i < 2000; i++) {
      writer.write([{ id: i }]);
    }

    // 1000 drop events occurred, but the warning must be throttled well
    // below that - it must not fire on every single drop.
    expect(warnSpy.mock.calls.length).toBeLessThan(50);
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
  });

  test('a single oversized batch is also capped at 1000, keeping the newest items', () => {
    const writer = new DelayedWriter('logUrl');
    const payloads = Array.from({ length: 1200 }, (_, i) => ({ id: i }));

    writer.write(payloads);

    expect(writer._queue.length).toBe(1000);
    expect(writer._queue[0]).toEqual({ id: 200 });
    expect(writer._queue[writer._queue.length - 1]).toEqual({ id: 1199 });
  });

  test('does not exceed the cap when queue is non-empty and new items arrive', () => {
    const writer = new DelayedWriter('logUrl');
    writer.write(Array.from({ length: 900 }, (_, i) => ({ id: i })));
    writer.write(Array.from({ length: 200 }, (_, i) => ({ id: 900 + i })));

    expect(writer._queue.length).toBe(1000);
  });
});
