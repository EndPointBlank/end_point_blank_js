'use strict';

const http = require('http');
const express = require('express');

const { instance: config } = require('../../src/configuration');
const { authenticated, versioned, registerExpressEndpoints } = require('../../src/express');
const { UnauthorizedError } = require('../../src/unauthorized-error');

/**
 * End-to-end proof that a route the SDK registered is a route the SDK can then
 * get authenticated.
 *
 * Intake resolves the endpoint row *before* it considers the credential:
 * `Intake.Apis.get_endpoint/3` matches `path` and `action` with SQL `=`
 * (`apis.ex:12-20`), and a miss is `{:error, :missing_target_endpoint}`
 * (`authorizations.ex:10-18`) which `AuthorizationController` renders with
 * `put_status(:unauthorized)`. So a guard that names the endpoint differently
 * from the way it was registered is refused with what reads like a grant
 * problem, on a credential that is entirely valid — the integrator goes and
 * debugs the credential.
 *
 * The two halves are checked against each other rather than against a fixture:
 * the rows this stub can resolve are the ones the SDK's own
 * `registerExpressEndpoints` published to it moments earlier, in the same test.
 * Nothing here tells the stub what the right path is. If registration and the
 * guard disagree by so much as a prefix, no row is found and the request is
 * refused, which is precisely what happens in production.
 *
 * A double cannot show this. `tests/express/authenticated.test.js` passed for
 * the entire life of the defect because every `req` in it was hand-built, and
 * the bug is in the fields Express fills in and the guard did not read.
 */

// `tests/setup/no-network.js` replaces `globalThis.fetch` in a `beforeEach` to
// fail any test that leaks a real outbound call. This test's calls are the
// point of it and go to a loopback port owned by this file, so it takes the
// real `fetch` back. Captured at module load, before any `beforeEach` runs.
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

/**
 * `Intake.PathNormalizer.normalize/1`, transcribed.
 *
 * It rewrites `{name}` and `{name:regex}` to `:name` and does nothing else —
 * no trailing slash is trimmed, no case is folded — and intake applies it to
 * both sides, at registration and on the authorize request. Express already
 * emits `:name`, so for this SDK it is the identity function; it is here so
 * the stub matches the way intake matches rather than the way this test would
 * find convenient.
 */
function normalize(path) {
  return typeof path === 'string' ? path.replace(/\{([^/}:]+)(?::[^}]*)?\}/g, ':$1') : path;
}

/**
 * A stub intake that stores what it is told and resolves the endpoint exactly,
 * the way `Intake.Apis.get_endpoint/3` does.
 */
function startStubIntake() {
  /** Registered rows, as `"METHOD path"`, exactly as intake would key them. */
  const endpoints = new Set();
  const authorizeCalls = [];

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

      const answer = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/api/application_updates') {
        for (const endpoint of body.endpoints || []) {
          endpoints.add(`${endpoint.http_method} ${normalize(endpoint.path)}`);
        }
        return answer(201, { ok: true });
      }

      if (req.url === '/api/authorize') {
        authorizeCalls.push(body);

        // The lookup, and the only thing this stub decides. `e.path == ^path
        // and e.action == ^http_method` — no prefix matching, no pattern
        // matching, no trailing-slash forgiveness.
        const found = endpoints.has(`${body.http_method} ${normalize(body.path)}`);

        return found
          ? answer(201, AUTHORIZED_BODY)
          : answer(401, { authorized: false, error: 'missing_target_endpoint' });
      }

      return answer(404, {});
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, endpoints, authorizeCalls });
    });
  });
}

/** A real client socket, deliberately not `fetch`. */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers }, res => {
      let raw = '';
      res.on('data', chunk => {
        raw += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    request.on('error', reject);
  });
}

/** Posts a body to the stub directly, to ask what it makes of that body alone. */
function postToStub(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

/**
 * The provider application, in the shape the README tells an integrator to
 * write: a router that declares paths relative to a prefix it is mounted under
 * and never sees.
 */
function buildApp() {
  const app = express();

  const students = express.Router();
  students.get('/', versioned(['v1']), authenticated, (req, res) =>
    res.status(200).json({ route: 'index' }));
  students.get('/:id', versioned(['v1']), authenticated, (req, res) =>
    res.status(200).json({ route: 'show', id: req.params.id }));
  app.use('/students', students);

  // Static, and declared on the app itself: the shape that works whether or
  // not the guard composes the path correctly.
  app.get('/health', versioned(['v1']), authenticated, (req, res) =>
    res.status(200).json({ route: 'health' }));

  // Guarded but never declared with `versioned`, so `collectEndpoints` skips
  // it and intake is never told it exists. Its only job is to show what an
  // endpoint intake cannot resolve looks like from the caller's side.
  app.get('/unregistered', authenticated, (req, res) =>
    res.status(200).json({ route: 'unregistered' }));

  // Copied verbatim from epb_test_js/src/app.js. That app is not modified.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof UnauthorizedError) {
      return res.status(err.statusCode || 401).json({ error: err.message });
    }
    console.error(err.stack);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}

describe('a registered endpoint can be authenticated', () => {
  let intake;
  let appServer;
  let appPort;

  beforeEach(async () => {
    globalThis.fetch = realFetch;

    jest.spyOn(console, 'error').mockImplementation(() => {});
    // `log.info` writes straight to stderr by design (`src/log.js`), so a
    // console spy does not reach it and every registration would print.
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    intake = await startStubIntake();

    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.baseUrl = `http://127.0.0.1:${intake.port}`;

    const app = buildApp();
    appServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => appServer.once('listening', resolve));
    appPort = appServer.address().port;

    // The SDK publishes its own endpoint list to the stub. Everything the stub
    // can resolve from here on, the SDK told it.
    await registerExpressEndpoints(app);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    config._reset();
    await new Promise(resolve => appServer.close(resolve));
    await new Promise(resolve => intake.server.close(resolve));
  });

  describe('a parameterized route on a router mounted under a prefix', () => {
    test('serves its own handler rather than a refusal', async () => {
      const response = await get(appPort, '/students/42', { authorization: 'Basic Y2xpZW50' });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ route: 'show', id: '42' });
    });

    test('is asked about under the path it was registered under', async () => {
      await get(appPort, '/students/42', { authorization: 'Basic Y2xpZW50' });

      expect(intake.authorizeCalls[0].path).toBe('/students/:id');
      expect(intake.endpoints).toContain('GET /students/:id');
    });
  });

  describe('an index route on a router mounted under a prefix', () => {
    test('serves its own handler rather than a refusal', async () => {
      const response = await get(appPort, '/students/', { authorization: 'Basic Y2xpZW50' });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ route: 'index' });
    });

    test('is asked about under the path it was registered under', async () => {
      await get(appPort, '/students/', { authorization: 'Basic Y2xpZW50' });

      // Not `/students/`: Express composes the index route as `prefix + '/'`,
      // and intake trims nothing, so the SDK must present the same form it
      // registered.
      expect(intake.authorizeCalls[0].path).toBe('/students');
      expect(intake.endpoints).toContain('GET /students');
    });
  });

  describe('a static route declared on the app itself', () => {
    /**
     * The control. This one is served with the defect in place, because with
     * no prefix to lose and no trailing slash to trim, building the path by
     * hand produces the same string the shared helper does. It is here to show
     * that the failures above are about path composition and not about the
     * harness, the credential, or the stub.
     */
    test('is served either way, which is what made the bug invisible', async () => {
      const response = await get(appPort, '/health', { authorization: 'Basic Y2xpZW50' });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ route: 'health' });
    });
  });

  describe('what the stub is actually keying on', () => {
    // Guards on the harness rather than regression tests: all of these pass
    // against master, because none of them runs the guard. They are what makes
    // the 200s above mean something — a stub that answered 201 to anything
    // would give the same green while proving nothing.
    test('a path that was registered resolves', async () => {
      const response = await postToStub(intake.port, '/api/authorize', {
        path: '/students/:id',
        http_method: 'GET',
      });

      expect(response.status).toBe(201);
    });

    test('the concrete URL is refused, because nothing is registered under it', async () => {
      const response = await postToStub(intake.port, '/api/authorize', {
        path: '/students/42',
        http_method: 'GET',
      });

      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({
        authorized: false,
        error: 'missing_target_endpoint',
      });
    });

    test('the route pattern without its prefix is refused', async () => {
      // The exact string the guard used to send for `/students/42`.
      const response = await postToStub(intake.port, '/api/authorize', {
        path: '/:id',
        http_method: 'GET',
      });

      expect(response.status).toBe(401);
    });

    test('a trailing slash is not forgiven', async () => {
      // Intake trims nothing. The string the guard would send for the index
      // route if it added the prefix but skipped normalization.
      const response = await postToStub(intake.port, '/api/authorize', {
        path: '/students/',
        http_method: 'GET',
      });

      expect(response.status).toBe(401);
    });

    test('the method has to match too', async () => {
      const response = await postToStub(intake.port, '/api/authorize', {
        path: '/students/:id',
        http_method: 'DELETE',
      });

      expect(response.status).toBe(401);
    });
  });

  describe('what an endpoint intake cannot resolve looks like to the caller', () => {
    /**
     * Also a harness guard — `/unregistered` is genuinely not registered, so
     * it is refused before and after the fix. It is here because it is the
     * only place the symptom is visible: this is what *every* route on a
     * mounted router answered before the fix, and there is nothing in it that
     * points at a path. An integrator reading it goes and checks the
     * credential they were issued, which is fine, and then the grant they were
     * given, which is also fine.
     */
    test('a 401 naming a grant, with nothing to suggest the path was wrong', async () => {
      const response = await get(appPort, '/unregistered', { authorization: 'Basic Y2xpZW50' });

      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({
        error: 'Authentication failed: missing_target_endpoint',
      });
    });
  });
});
