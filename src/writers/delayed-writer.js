'use strict';

const { DirectWriter } = require('./direct-writer');

const BATCH_SIZE = 4;

// Upper bound on how many payloads may sit in the in-memory background queue.
// Without a cap, a sustained intake outage lets the queue grow unboundedly
// and eventually OOMs the Node process. When the cap is hit we drop the
// *oldest* payloads first (FIFO eviction) so the writer keeps making forward
// progress with the most recent data instead of wedging entirely.
const MAX_QUEUE_SIZE = 1000;

// The drop-warning is throttled so a sustained outage (which can trigger
// thousands of individual drops) doesn't spam stderr once per drop. We log
// at most once per this window.
const DROP_WARN_THROTTLE_MS = 30_000;

/**
 * Asynchronous writer that queues payloads and flushes them in the background.
 *
 * JavaScript is single-threaded, so "delayed" means the flush is deferred via
 * `setImmediate` / microtask queue rather than a worker thread. Batches up to
 * 4 payloads per HTTP request.
 *
 * The queue is bounded at `MAX_QUEUE_SIZE`; once full, the oldest queued
 * payloads are dropped to make room for new ones (see `_bound`).
 *
 * Equivalent to the Ruby gem's `EndPointBlank::DelayedWriter`.
 */
class DelayedWriter {
  /**
   * @param {string} urlKey
   */
  constructor(urlKey) {
    this._direct = new DirectWriter(urlKey);
    /** @type {object[]} */
    this._queue = [];
    this._flushing = false;
    this._lastDropWarnAt = 0;
  }

  /**
   * Enqueues *payloads* for asynchronous delivery.
   *
   * @param {object[]} payloads
   */
  write(payloads) {
    this._queue.push(...payloads);
    this._bound();
    if (!this._flushing) {
      this._flushing = true;
      setImmediate(() => this._flush());
    }
  }

  /**
   * Enforces `MAX_QUEUE_SIZE` by dropping the oldest queued payloads,
   * emitting a throttled warning when it does so.
   */
  _bound() {
    if (this._queue.length <= MAX_QUEUE_SIZE) return;

    const dropped = this._queue.length - MAX_QUEUE_SIZE;
    this._queue.splice(0, dropped);

    const now = Date.now();
    if (now - this._lastDropWarnAt >= DROP_WARN_THROTTLE_MS) {
      this._lastDropWarnAt = now;
      console.warn(
        `[EndPointBlank] DelayedWriter queue exceeded ${MAX_QUEUE_SIZE} items; ` +
          `dropping oldest payload(s) (further drops suppressed for ${DROP_WARN_THROTTLE_MS / 1000}s)`,
      );
    }
  }

  async _flush() {
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, BATCH_SIZE);
      try {
        await this._direct.write(batch);
      } catch (err) {
        console.error(`[EndPointBlank] DelayedWriter flush error: ${err.message}`);
      }
    }
    this._flushing = false;
  }
}

module.exports = { DelayedWriter };
