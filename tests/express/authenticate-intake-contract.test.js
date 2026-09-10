'use strict';

const http = require('http');
const express = require('express');

const { instance: config } = require('../../src/configuration');
const { authenticated } = require('../../src/express');
const { UnauthorizedError } = require('../../src/unauthorized-error');

/**
 * End-to-end proof that the `authenticated` guard can actually be satisfied.
 *
 * Everything here is real: a real Express app on this branch's `src/`, the real
 * `authenticated` middleware guarding a real route, the SDK's real `fetch` call
 * over loopback, and a real client socket asking for the route. The only stand-
 * in is intake itself, and the stub refuses the way intake refuses.
 *
 * A unit test with an in-process double proves nothing about this bug, and that
 * is not a hypothetical: `tests/commands/basic-authenticate.test.js` pinned
 * `action: 'POST'` and passed for the entire life of the defect. A double
 * answers whatever it is asked. Only something on the far end of a socket that
 * refuses on the *key* can tell the difference between a body intake reads and
 * a body it ignores.
 *
 * The stub's rule is intake's rule, not a list of names known to be wrong:
 * every clause of `Intake.AuthorizeAccess.authorize/1` pattern-matches
 * `http_method` (`authorize_access.ex:17` and `:62`), so a body without that key
 * falls through to `def authorize(_params), do: {:error, :invalid_params}`
 * (`authorize_access.ex:88-90`) and `AuthorizationController` renders it with
 * `put_status(:unauthorized)` — a 401 carrying
 * `%{authorized: false, error: "invalid_params"}`. The stub tests for the
 * presence of the key and nothing else, so it refuses `action`, `verb`, or no
 * method key at all for the same reason, and would accept a correct body it had
 * never been told about.
 *
 * Elixir's `%{"http_method" => value}` matches a nil value, so presence of the
 * key — not truthiness — is the faithful reproduction.
 */

// `tests/setup/no-network.js` replaces `globalThis.fetch` in a `beforeEach` to
// fail any test that leaks a real outbound call. This test's calls are the
// point of it, and they go to a loopback port owned by this file, so it takes
// the real `fetch` back. Captured at module load, which happens before any
// `beforeEach` has run.
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

/** Intake's 401 body for `{:error, :invalid_params}` (`AuthorizationJSON.error/1`). */
const INVALID_PARAMS_BODY = { authorized: false, error: 'invalid_params' };

function startStubIntake() {
  const received = [];

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
      received.push({ url: req.url, authorization: req.headers.authorization, body });

      const answer = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (!Object.prototype.hasOwnProperty.call(body, 'http_method')) {
        return answer(401, INVALID_PARAMS_BODY);
      }
      return answer(201, AUTHORIZED_BODY);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
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
function postToStub(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/authorize',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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

function buildApp() {
  const app = express();

  app.get('/whoami', authenticated, (req, res) =>
    res.status(200).json({ application: config.appName, authenticated: true }));

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

describe('the authenticated guard against a stub intake that refuses like intake', () => {
  let intake;
  let appServer;
  let appPort;

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

    appServer = buildApp().listen(0, '127.0.0.1');
    await new Promise(resolve => appServer.once('listening', resolve));
    appPort = appServer.address().port;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    config._reset();
    await new Promise(resolve => appServer.close(resolve));
    await new Promise(resolve => intake.server.close(resolve));
  });

  test('a guarded route serves its own handler rather than a refusal', async () => {
    const response = await get(appPort, '/whoami', {
      authorization: 'Basic Y2xpZW50',
      'x-api-version': 'v3',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ application: 'billing', authenticated: true });
  });

  test('the call intake was asked to judge carries the keys intake reads', async () => {
    await get(appPort, '/whoami', { authorization: 'Basic Y2xpZW50', 'x-api-version': 'v3' });

    expect(intake.received).toHaveLength(1);
    const { url, authorization, body } = intake.received[0];

    expect(url).toBe('/api/authorize');
    expect(authorization).toMatch(/^Basic /);
    expect(body.http_method).toBe('GET');
    expect(body.path).toBe('/whoami');
    expect(body.client_auth).toBe('Basic Y2xpZW50');
    expect(body.endpoint_version).toBe('3');
    // The address of the client socket above, so this is the real thing rather
    // than a value the test supplied. Intake stores it as `source_ip_address`;
    // it was recorded as nil on every authenticate row until now.
    // Loopback, either as Node reports it on an IPv4 socket or in the
    // IPv4-mapped IPv6 form some platforms hand back.
    expect(body.source_ip).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  test('and none of the keys intake ignores', async () => {
    await get(appPort, '/whoami', { authorization: 'Basic Y2xpZW50', 'x-api-version': 'v3' });

    const keys = Object.keys(intake.received[0].body);

    expect(keys).not.toContain('action');
    expect(keys).not.toContain('version');
    expect(keys).not.toContain('ip_address');
  });

  describe('what the stub is actually keying on', () => {
    // These drive the stub directly, so they are **guards on the harness**
    // rather than regression tests: all four pass against master, because none
    // of them runs any SDK code. They are what makes the 200 above mean
    // something. Without them, a stub that answered 201 to anything would give
    // exactly the same green, and the three tests above it would be proving
    // nothing at all.
    const withoutMethod = {
      path: '/whoami',
      action: 'GET',
      client_auth: 'Basic Y2xpZW50',
      application: 'billing',
      version: '3',
      ip_address: '127.0.0.1',
    };

    test('the body this command used to send is refused, exactly as intake refuses it', async () => {
      const response = await postToStub(intake.port, withoutMethod);

      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ authorized: false, error: 'invalid_params' });
    });

    test('the same body with http_method added is accepted', async () => {
      // One key is the entire difference. Nothing else about the body changed,
      // so the refusal above cannot have been about `action`, `version` or
      // `ip_address` being present — it was about `http_method` being absent.
      const response = await postToStub(intake.port, { ...withoutMethod, http_method: 'GET' });

      expect(response.status).toBe(201);
      expect(JSON.parse(response.body).authorized).toBe(true);
    });

    test('a body whose only method key is a third spelling is refused too', async () => {
      // The stub is not holding a list of wrong names. `verb` has never been
      // sent by anything in this project; it is refused for the same reason
      // `action` is, which is that it is not `http_method`.
      const response = await postToStub(intake.port, { path: '/whoami', verb: 'GET' });

      expect(response.status).toBe(401);
    });

    test('a null http_method is still a present http_method', async () => {
      // Elixir's `%{"http_method" => http_method}` matches a nil value, so the
      // clause is entered and the request is judged on its merits rather than
      // rejected as invalid_params. Presence, not truthiness.
      const response = await postToStub(intake.port, { path: '/whoami', http_method: null });

      expect(response.status).toBe(201);
    });
  });
});
