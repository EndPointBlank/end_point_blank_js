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

describe('DelayedWriter background flush', () => {
  const { instance: config } = require('../../src/configuration');

  let sent;

  // Drains the immediate queue until the writer has nothing left to do. No
  // timers and no wall-clock waits, so there is nothing here to go flaky.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  };

  beforeEach(() => {
    config._reset();
    sent = [];
    DirectWriter.mockImplementation(() => ({
      write: jest.fn(async batch => {
        sent.push(batch);
      }),
    }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    config._reset();
  });

  test('returns to the caller before anything is sent', async () => {
    // The whole point of the delayed mode: the customer's request is never
    // made to wait on a telemetry POST.
    const writer = new DelayedWriter('logUrl');

    writer.write([{ id: 1 }]);

    expect(sent).toEqual([]);

    // Let the scheduled flush finish so it cannot land during a later test.
    await settle();
  });

  test('sends everything that was queued', async () => {
    const writer = new DelayedWriter('logUrl');

    writer.write(Array.from({ length: 10 }, (_, i) => ({ id: i })));
    await settle();

    expect(sent.flat()).toHaveLength(10);
  });

  test('delivers each payload exactly once across concurrent workers', async () => {
    // Several drains share one queue. If two workers ever grabbed overlapping
    // slices, records would be duplicated or silently lost.
    const writer = new DelayedWriter('logUrl');

    writer.write(Array.from({ length: 37 }, (_, i) => ({ id: i })));
    await settle();

    expect(sent.flat().map(p => p.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 37 }, (_, i) => i),
    );
  });

  test('batches rather than sending one request per payload', async () => {
    const writer = new DelayedWriter('logUrl');

    writer.write(Array.from({ length: 8 }, (_, i) => ({ id: i })));
    await settle();

    expect(sent.length).toBeLessThan(8);
    for (const batch of sent) expect(batch.length).toBeLessThanOrEqual(4);
  });

  test('keeps draining after a batch fails to send', async () => {
    // One rejected batch must not strand the rest of the queue, or a single
    // blip would stop telemetry until the process restarts.
    let calls = 0;
    DirectWriter.mockImplementation(() => ({
      write: jest.fn(async batch => {
        calls += 1;
        if (calls === 1) throw new Error('connection reset');
        sent.push(batch);
      }),
    }));
    const writer = new DelayedWriter('logUrl');

    writer.write(Array.from({ length: 12 }, (_, i) => ({ id: i })));
    await settle();

    expect(sent.flat().length).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(1);
  });

  test('accepts new work after an earlier flush has finished', async () => {
    const writer = new DelayedWriter('logUrl');

    writer.write([{ id: 1 }]);
    await settle();
    writer.write([{ id: 2 }]);
    await settle();

    expect(sent.flat()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('still drains when workerCount is nonsense', async () => {
    // `workerCount` is customer-supplied. A zero or negative value must not
    // produce zero workers and a queue that never empties.
    config.workerCount = 0;
    const writer = new DelayedWriter('logUrl');

    writer.write(Array.from({ length: 6 }, (_, i) => ({ id: i })));
    await settle();

    expect(sent.flat()).toHaveLength(6);
  });

  test('honours a configured worker count', async () => {
    config.workerCount = 1;
    const writer = new DelayedWriter('logUrl');

    writer.write(Array.from({ length: 6 }, (_, i) => ({ id: i })));
    await settle();

    expect(sent.flat()).toHaveLength(6);
  });
});
