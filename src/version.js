'use strict';

/**
 * The single source of truth for this library's version.
 *
 * Read from `package.json` rather than restated as a literal. The version was
 * previously hardcoded in both `index.js` and `commands/endpoint-update.js`,
 * and both drifted to `0.2.2` while `package.json` moved to `0.4.0` — so every
 * deployment reported a stale `lib_version` to the portal, making it useless
 * for answering which customers run which SDK build.
 *
 * `package.json` always ships in the published tarball, and this is a Node
 * server library (`engines.node >= 18`), so the require resolves for consumers
 * as reliably as it does here.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::VERSION`, whose gemspec reads
 * the constant for the same reason.
 */
const { version: VERSION } = require('../package.json');

module.exports = { VERSION };
