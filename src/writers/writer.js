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
   * There is deliberately no `applyMasking` call here, and adding one would be
   * a bug rather than an extra safeguard. {@link PayloadBuilder.build} applies
   * the configured `maskingRules` and `maskHook` itself — it has to, because it
   * is exported and usable without this class — so what it returns is already
   * masked. Masking it again would apply every rule twice, and masking is not
   * idempotent: a `replacement_value` can re-match its own `regex` (`\d+` →
   * `[$0]` turns `42` into `[42]`, then `[[42]]`), and `maskHook` is arbitrary
   * caller code. Twice-masked is corrupt, not safer. This is unlike
   * `RequestWriter`, `ResponseWriter` and `ExceptionWriter`, which shape their
   * own payloads inline and so each mask their own; this class shapes nothing
   * and masks nothing. See sc-355.
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
