'use strict';

const fs = require('fs');
const path = require('path');

/**
 * This SDK runs inside someone else's process. Anything it writes to stdout
 * lands in the host application's own output, corrupting any program whose
 * stdout carries structured data — a CLI emitting JSON, a worker writing a
 * protocol stream. The host cannot separate the two.
 *
 * The SDK used to log through `console.info`, which Node routes to stdout.
 * This was found by the cross-SDK conformance drivers, which emit one JSON
 * object on stdout and were being corrupted by the SDK's own diagnostics.
 *
 * These tests are the guard against it coming back.
 */

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/**
 * Strips block and line comments so a mention of `console.log` in prose — the
 * kind `src/log.js` deliberately contains to explain itself — is not mistaken
 * for a call.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the SDK never writes to the host application’s stdout', () => {
  it('calls no stdout-bound console method anywhere in src/', () => {
    const offenders = [];

    for (const file of sourceFiles(SRC)) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (/\bconsole\.(log|info|debug|dir|table)\s*\(/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    // console.error and console.warn are fine — Node routes both to stderr.
    // Informational output goes through src/log.js, which writes to stderr too.
    expect(offenders).toEqual([]);
  });

  it('log.info writes to stderr and leaves stdout untouched', () => {
    const log = require('../src/log');

    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      log.info('[EndPointBlank] a diagnostic line');

      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith('[EndPointBlank] a diagnostic line\n');
    } finally {
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
  });
});
