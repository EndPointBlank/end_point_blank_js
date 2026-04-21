'use strict';

const { DirectWriter } = require('./direct-writer');

const BATCH_SIZE = 4;

/**
 * Asynchronous writer that queues payloads and flushes them in the background.
 *
 * JavaScript is single-threaded, so "delayed" means the flush is deferred via
 * `setImmediate` / microtask queue rather than a worker thread. Batches up to
 * 4 payloads per HTTP request.
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
  }

  /**
   * Enqueues *payloads* for asynchronous delivery.
   *
   * @param {object[]} payloads
   */
  write(payloads) {
    this._queue.push(...payloads);
    if (!this._flushing) {
      this._flushing = true;
      setImmediate(() => this._flush());
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
