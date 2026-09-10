'use strict';

const { instance: config, LogMode } = require('../configuration');
const { PayloadBuilder } = require('../payload-builder');
const { DirectWriter } = require('./direct-writer');
const { DelayedWriter } = require('./delayed-writer');

/**
 * Factory writer that builds an error payload with {@link PayloadBuilder} and
 * delegates the send to {@link DirectWriter} or {@link DelayedWriter}, per the
 * configured {@link LogMode}.
 *
 * Nothing inside this library uses it; like {@link PayloadBuilder} it exists
 * for callers reaching in through `./src/*`, which is why the two drifted from
 * the writers the middleware actually drives. There is no
 * `EndPointBlank::Writers::Writer` in the Ruby gem, whatever this file used to
 * claim — the gem has a writer per record type and no factory.
 */
class Writer {
  /**
   * @param {string} urlKey - URL key passed to the underlying writer.
   */
  constructor(urlKey) {
    this._urlKey = urlKey;
    this._writer = null;
  }

  /**
   * Builds a payload and sends it via the appropriate writer.
   *
   * `opts` is handed to {@link PayloadBuilder.build} whole rather than
   * relisted here. Relisting it is how `stacktrace` came to be silently
   * dropped: the builder has always accepted a caller-supplied trace, and this
   * method destructured every option except that one, so passing it did
   * nothing. A second copy of the option list is a second thing to drift.
   *
   * @param {object} opts - See {@link PayloadBuilder.build}.
   * @returns {Promise<void>}
   */
  async write(opts) {
    const payload = PayloadBuilder.build(opts);
    await this._getWriter().write([payload]);
  }

  _getWriter() {
    if (!this._writer) {
      this._writer = config.logMode === LogMode.DELAYED
        ? new DelayedWriter(this._urlKey)
        : new DirectWriter(this._urlKey);
    }
    return this._writer;
  }
}

module.exports = { Writer };
