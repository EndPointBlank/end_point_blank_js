'use strict';

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const { VERSION } = require('../src/version');
const epb = require('../src/index');

const SRC = path.join(__dirname, '..', 'src');

/** Every `.js` file under `src/`, recursively. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

describe('the version the library reports', () => {
  test('is the version in package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });

  test('is what the public entry point exposes', () => {
    // `VERSION` is part of the documented top-level API, so a consumer reading
    // it must see the same string the manifest publishes.
    expect(epb.VERSION).toBe(pkg.version);
  });

  test('is not restated as a literal anywhere in src/', () => {
    // The guard that actually matters. Correcting the constant is a one-time
    // fix; what let it rot for two releases was that the version lived in two
    // hand-maintained copies. Deriving it from package.json only helps while
    // every caller keeps deriving it, so fail the build if a new literal
    // reappears rather than trusting reviewers to notice.
    //
    // Matches `VERSION = '1.2.3'` in any casing of the name; ignores the
    // API-version regexes in commands/version-finder.js, which match request
    // headers rather than assigning a semver string.
    const literal = /VERSION\s*=\s*['"`]\d+\.\d+/i;

    const offenders = sourceFiles()
      .filter(file => literal.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(path.join(__dirname, '..'), file));

    expect(offenders).toEqual([]);
  });
});
