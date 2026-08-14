'use strict';

/**
 * Diagnostic output for this SDK.
 *
 * Everything here goes to **stderr**, deliberately.
 *
 * This library runs inside someone else's process. `console.info` and
 * `console.log` write to stdout, so anything the SDK logged through them landed
 * in the host application's own output — corrupting any program whose stdout
 * carries structured data, such as a CLI emitting JSON or a worker writing a
 * protocol stream. The host has no way to separate the two.
 *
 * Diagnostics belong on stderr for exactly that reason. `console.error` and
 * `console.warn` already write there and are used directly elsewhere in the
 * SDK; this exists so informational messages can go to the right stream
 * without being relabelled as errors.
 *
 * Found by the SDK conformance drivers, which emit one JSON object on stdout
 * and were being corrupted by the SDK's own diagnostics.
 */

/**
 * Writes an informational diagnostic to stderr.
 *
 * @param {string} message
 */
function info(message) {
  process.stderr.write(`${message}\n`);
}

module.exports = { info };
