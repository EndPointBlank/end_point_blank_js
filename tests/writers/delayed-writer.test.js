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

describe('DelayedWriter flush window (sc-347)', () => {
  const { instance: config } = require('../../src/configuration');

  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  };

  /**
   * Starts a flush and hands back the point in time we care about.
   *
   * The returned `window` promise is the promise the *first* in-flight batch is
   * awaiting. A `.then()` registered on it after the writer has already
   * suspended on it runs *after* the worker's own continuation - i.e. after
   * that worker has re-checked the (now empty) queue and left its drain loop,
   * but before `_flush()` gets to clear `_flushing`. That is exactly the
   * window this story is about, and reaching it this way is deterministic
   * promise-callback ordering rather than a tick count that could drift.
   */
  const startFlushAndHoldFirstBatch = () => {
    const sent = [];
    let release;
    const window = new Promise(resolve => { release = resolve; });

    DirectWriter.mockImplementation(() => ({
      // NOT an `async` function: the worker must `await` this exact promise so
      // our own `.then()` lands behind the worker's resume.
      write: jest.fn(batch => {
        sent.push(batch);
        return sent.length === 1 ? window : Promise.resolve();
      }),
    }));

    return { sent, window, release };
  };

  beforeEach(() => {
    config._reset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    config._reset();
  });

  test('delivers a payload written after every worker has left its drain loop', async () => {
    const { sent, window, release } = startFlushAndHoldFirstBatch();
    const writer = new DelayedWriter('logUrl');

    writer.write([{ id: 'first' }]);
    await new Promise(resolve => setImmediate(resolve));

    // The flush is running, the queue is empty, and the only worker still
    // alive is parked on `window`.
    expect(sent.flat().map(p => p.id)).toEqual(['first']);
    expect(writer._queue).toHaveLength(0);
    expect(writer._flushing).toBe(true);

    const injected = window.then(() => writer.write([{ id: 'second' }]));
    release();
    await injected;
    await settle();

    // Before this fix `second` sat in the queue forever: it arrived while
    // `_flushing` was still true, so `write()` scheduled nothing, and the
    // flush that was about to end had already stopped looking at the queue.
    expect(sent.flat().map(p => p.id)).toEqual(['first', 'second']);
    expect(writer._queue).toHaveLength(0);
    expect(writer._flushing).toBe(false);
  });

  test('delivers a whole burst of payloads written inside the flush window', async () => {
    const { sent, window, release } = startFlushAndHoldFirstBatch();
    const writer = new DelayedWriter('logUrl');

    writer.write([{ id: 0 }]);
    await new Promise(resolve => setImmediate(resolve));

    const injected = window.then(() => {
      for (let i = 1; i <= 9; i++) writer.write([{ id: i }]);
    });
    release();
    await injected;
    await settle();

    expect(sent.flat().map(p => p.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(writer._queue).toHaveLength(0);
  });

  test('does not wedge when a worker fails in a way `_drain` cannot format', async () => {
    // `_drain` catches send failures, but its handler builds the log line out
    // of `err.message`. A rejection whose value is not an object throws a
    // TypeError straight back out of the catch that was meant to contain it,
    // rejecting `Promise.all` - so `_flushing` was never cleared. That pins
    // the writer permanently: the queue climbs to MAX_QUEUE_SIZE and starts
    // evicting the oldest payloads with nothing left to drain it, and the
    // rejection goes unhandled (fatal under Node's default
    // `--unhandled-rejections=throw`).
    const attempts = [];
    DirectWriter.mockImplementation(() => ({
      write: jest.fn(batch => {
        attempts.push(batch);
        return Promise.reject(null);
      }),
    }));

    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const writer = new DelayedWriter('logUrl');

      writer.write([{ id: 0 }]);
      await settle();

      expect(writer._flushing).toBe(false);

      // ...and the writer is still usable afterwards rather than silently
      // accumulating and then evicting.
      for (let i = 1; i <= 1200; i++) writer.write([{ id: i }]);
      await settle();

      expect(writer._queue).toHaveLength(0);
      expect(attempts.length).toBeGreaterThan(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('releases the in-flight flag even if a worker throws outright', async () => {
    // Belt-and-braces on the guarantee above, independent of *why* a worker
    // might blow up: whatever happens in the drain path, `_flush` has to hand
    // the flag back or the writer is shut for the life of the process. The
    // failure must also be loud rather than swallowed silently.
    const writer = new DelayedWriter('logUrl');
    jest.spyOn(writer, '_drain').mockRejectedValue(new Error('worker exploded'));

    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      writer.write([{ id: 'doomed' }]);
      await settle();

      expect(writer._flushing).toBe(false);
      expect(unhandled).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('worker exploded'),
      );

      // The writer is still armable: a later write schedules a fresh flush.
      writer._drain.mockRestore();
      writer.write([{ id: 'after' }]);
      await settle();

      expect(writer._queue).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
