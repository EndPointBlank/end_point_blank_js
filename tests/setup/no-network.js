'use strict';

/**
 * Fails any test that would make a real outbound HTTP call.
 *
 * Three tests in tests/middleware/report-interaction.test.js did exactly that.
 * They drove the real middleware, whose writers POST to the configured
 * applicationErrorsUrl and requestsUrl — which default to the production host —
 * so every local and CI run wrote junk request and error rows into production
 * intake. The spies those tests carried could not have caught it: they watched
 * `Writer.prototype.write`, a class that code path never touches.
 *
 * The deeper problem was that nothing made the mistake visible. A leaked call
 * is fire-and-forget and its failure is swallowed, so the test passed either
 * way. This turns that silence into a failure.
 *
 * A test that genuinely wants to exercise the HTTP layer assigns its own
 * `global.fetch` (see tests/commands/_http.test.js). That replaces this guard
 * outright, so deliberate stubbing is unaffected — what remains caught is the
 * unintentional case, where nobody stubbed anything and the call was real.
 */

let attempted = [];

beforeEach(() => {
  attempted = [];

  globalThis.fetch = (url, options = {}) => {
    attempted.push(`${options.method || 'GET'} ${url}`);

    // Resolve rather than reject. A rejection sends `_http.post` into its retry
    // loop, whose 200ms delays would land in a later test's window and report
    // the leak against the wrong test.
    return Promise.resolve({
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => '',
      clone() {
        return this;
      },
    });
  };
});

afterEach(() => {
  if (attempted.length === 0) return;

  const leaked = [...new Set(attempted)];
  attempted = [];

  throw new Error(
    `This test made ${leaked.length} unstubbed outbound HTTP call(s):\n` +
      leaked.map(call => `  - ${call}`).join('\n') +
      '\n\nMock at the boundary instead — jest.mock the module under test, or ' +
      "assign your own global.fetch if you're testing the HTTP layer itself."
  );
});
