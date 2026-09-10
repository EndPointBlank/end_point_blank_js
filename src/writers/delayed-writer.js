'use strict';

const { instance: config } = require('../configuration');
const { DirectWriter } = require('./direct-writer');

const BATCH_SIZE = 4;

// Fallback concurrency when `config.workerCount` is unset/falsy. Mirrors the
// `Configuration` default so behavior is unchanged for callers who never
// touch `workerCount`.
const DEFAULT_WORKER_COUNT = 4;

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
 * Renders whatever a `catch` caught as a log-safe string.
 *
 * A rejected promise carries an arbitrary value, not necessarily an `Error`.
 * Reading `.message` off a `null`/`undefined` rejection throws a `TypeError`
 * straight back out of the handler that was supposed to contain it - which,
 * in `_drain`, took the whole flush down with it.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  return (err && err.message) || String(err);
}

/**
 * Asynchronous writer that queues payloads and flushes them in the background.
 *
 * JavaScript is single-threaded, so "delayed" means the flush is deferred via
 * `setImmediate` / microtask queue rather than an OS thread. Batches up to 4
 * payloads per HTTP request, and drains the queue using up to
 * `config.workerCount` concurrent in-flight batch requests (falling back to
 * `DEFAULT_WORKER_COUNT` when unset/invalid) — the closest single-threaded
 * analog to the Ruby gem's threaded writer pool.
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
    this._schedule();
  }

  /**
   * Arms a background flush unless one is already in flight.
   *
   * Shared by `write()` and by `_flush()`'s own re-check so the two can never
   * drift apart on what "already scheduled" means.
   */
  _schedule() {
    if (this._flushing) return;
    this._flushing = true;
    setImmediate(() => this._flush());
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
    const workerCount = Number.isInteger(config.workerCount) && config.workerCount > 0
      ? config.workerCount
      : DEFAULT_WORKER_COUNT;

    let drained = false;
    try {
      const workers = Array.from({ length: workerCount }, () => this._drain());
      // `allSettled`, not `all`. `all` settles the moment one worker rejects,
      // while its siblings are still awaiting their POSTs - so the `finally`
      // below would clear `_flushing` mid-cohort, and the next `write()` would
      // arm a second cohort on top of the first. More than `workerCount`
      // requests would then be in flight, which is the one bound this class
      // offers its caller. `splice` is synchronous so nothing would be sent
      // twice, but the concurrency limit would be silently exceeded.
      //
      // `_drain` swallows its own send failures, so a rejected worker is the
      // unanticipated path; on the ordinary one every worker has already
      // returned and waiting for the cohort costs nothing.
      const results = await Promise.allSettled(workers);
      const rejected = results.filter(r => r.status === 'rejected');
      for (const { reason } of rejected) {
        console.error(`[EndPointBlank] DelayedWriter flush aborted: ${describeError(reason)}`);
      }
      drained = rejected.length === 0;
    } catch (err) {
      // Backstop only: `Promise.allSettled` does not reject, so reaching here
      // means something threw synchronously before it. Swallow it - nothing
      // awaits this promise, and an unhandled rejection is fatal under Node's
      // default `--unhandled-rejections=throw`.
      console.error(`[EndPointBlank] DelayedWriter flush aborted: ${describeError(err)}`);
    } finally {
      // Must happen on every path. Leaving this set pins the writer shut: no
      // later `write()` can arm a flush, so the queue climbs to
      // `MAX_QUEUE_SIZE` and starts evicting with nothing left to drain it.
      this._flushing = false;
    }

    // Workers stop as soon as they see an empty queue, which leaves a window
    // between the last one leaving its loop and the flag clearing above. A
    // `write()` landing in that window found `_flushing` still true and armed
    // nothing, so its payloads would sit here until some later write happened
    // to arrive with the flag clear - in a quiet process, never. Re-check now
    // that the flag is down; the two statements are synchronous, so there is
    // no second window between them.
    //
    // Only after a clean drain: re-arming when a worker blew up could spin
    // `setImmediate` forever against a queue nothing is able to empty.
    if (drained && this._queue.length > 0) this._schedule();
  }

  /**
   * Repeatedly pulls a batch off the shared queue and flushes it, until the
   * queue is empty. Multiple `_drain()` calls run concurrently (one per
   * "worker") so several batches can be in flight at once; `Array.splice` is
   * synchronous, so concurrent workers never grab overlapping items.
   */
  async _drain() {
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, BATCH_SIZE);
      if (batch.length === 0) break;
      try {
        await this._direct.write(batch);
      } catch (err) {
        console.error(`[EndPointBlank] DelayedWriter flush error: ${describeError(err)}`);
      }
    }
  }
}

module.exports = { DelayedWriter };
