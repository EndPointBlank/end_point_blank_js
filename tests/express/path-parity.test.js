'use strict';

const http = require('http');
const express = require('express');

const { instance: config } = require('../../src/configuration');
const { instance: authCache } = require('../../src/commands/authentication-cache');
const { authenticated, authorized } = require('../../src/express');
const { UnauthorizedError } = require('../../src/unauthorized-error');

/**
 * The two Express guards ask intake about the same endpoint, and for the same
 * request they must name it the same way.
 *
 * `request-path.js` exists because registration and the authorize lookup have
 * to produce byte-identical paths — intake stores what registration told it and
 * matches it exactly. `authorized` was moved onto that function; `authenticated`
 * kept its own transcription, `req.route?.path || req.path || req.url`, which
 * neither prefixes `req.baseUrl` nor strips the trailing slash Express composes
 * onto an index route. So a router mounted at `/whoami` with `router.get('/')`
 * registered as `/whoami`, authorized as `/whoami`, and authenticated as `/` —
 * an endpoint intake has never been told about, and every request through that
 * guard fails with `missing_target_endpoint` while both halves look correct in
 * isolation.
 *
 * Sibling of `refusal-parity.test.js`, and for the same reason: two copies of
 * one decision is how one path acquires a fix the other does not. That one pins
 * the status the guards refuse with; this pins the path they ask about.
 *
 * Everything below is real — a real Express app, a real mount point, a real
 * `req.baseUrl` filled in by Express itself, and the SDK's real `fetch` over
 * loopback. A fabricated `req` cannot prove this: `baseUrl` is precisely the
 * field the broken guard ignored, and a hand-written object is only ever as
 * honest as the hand that wrote it. The one stand-in is intake, and all it does
 * is write down the path it was asked about.
 */

// `tests/setup/no-network.js` replaces `globalThis.fetch` in a `beforeEach` to
// fail any test that leaks a real outbound call. This file's calls are the point
// of it and go to a loopback port it owns, so it takes the real `fetch` back.
// Captured at module load, before any `beforeEach` has run.
const realFetch = globalThis.fetch;

/** Intake's 201 body for an authorized call (`AuthorizationJSON.show/1`). */
const AUTHORIZED_BODY = {
  authorized: true,
  data: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      source_application_environment_id: '22222222-2222-4222-8222-222222222222',
      target_application_environment_id: '33333333-3333-4333-8333-333333333333',
      inserted_at: '2026-09-10T00:00:00Z',
    },
  ],
};

/** Approves everything, and writes down the path it was asked about. */
function startStubIntake() {
  const asked = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      asked.push(body.path);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(AUTHORIZED_BODY));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, asked });
    });
  });
}

/** A real client socket, deliberately not `fetch`. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path, headers: { authorization: 'Basic Y2xpZW50' } },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      },
    );
    request.on('error', reject);
  });
}

const handler = (req, res) => res.status(200).json({ ok: true });

// Copied from epb_test_js/src/app.js, so a refusal surfaces as a status rather
// than as an unhandled error.
function withErrorHandler(app) {
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof UnauthorizedError) {
      return res.status(err.statusCode || 401).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });
  return app;
}

/**
 * The route shapes, each built around whichever guard is being asked. Both
 * guards see exactly the same mount point and the same route pattern, so any
 * difference in what they report is the guard's own.
 */
const SHAPES = {
  'an index route on a router mounted at /whoami': {
    build: guard => {
      const app = express();
      const router = express.Router();
      router.get('/', guard, handler);
      app.use('/whoami', router);
      return withErrorHandler(app);
    },
    call: '/whoami',
    expected: '/whoami',
  },
  'a param route on a router mounted at /books': {
    build: guard => {
      const app = express();
      const router = express.Router();
      router.get('/:id', guard, handler);
      app.use('/books', router);
      return withErrorHandler(app);
    },
    call: '/books/7',
    expected: '/books/:id',
  },
  'a top-level route': {
    build: guard => {
      const app = express();
      app.get('/whoami', guard, handler);
      return withErrorHandler(app);
    },
    call: '/whoami',
    expected: '/whoami',
  },
};

describe('the two guards name the same endpoint the same way', () => {
  let intake;

  beforeEach(async () => {
    globalThis.fetch = realFetch;

    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    intake = await startStubIntake();

    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.baseUrl = `http://127.0.0.1:${intake.port}`;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    config._reset();
    await new Promise(resolve => intake.server.close(resolve));
  });

  /** Drives one shape through one guard and returns the path intake was asked about. */
  const pathAskedAbout = async (guard, shape) => {
    // `EndpointAuthorize` caches a successful authorization keyed partly on the
    // path, and a cache hit answers without calling intake at all.
    authCache.clear();

    const server = shape.build(guard).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));

    try {
      const before = intake.asked.length;
      const response = await get(server.address().port, shape.call);

      expect(response.status).toBe(200);
      expect(intake.asked.length).toBe(before + 1);

      return intake.asked[before];
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  };

  test.each(Object.entries(SHAPES))('%s', async (_name, shape) => {
    const viaAuthenticate = await pathAskedAbout(authenticated, shape);
    const viaAuthorize = await pathAskedAbout(authorized, shape);

    expect(viaAuthorize).toBe(shape.expected);
    expect(viaAuthenticate).toBe(shape.expected);
    expect(viaAuthenticate).toBe(viaAuthorize);
  });
});
