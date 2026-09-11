'use strict';

const http = require('http');
const express = require('express');

const { instance: config } = require('../../src/configuration');
const { instance: authCache } = require('../../src/commands/authentication-cache');
const { authorized } = require('../../src/express');
const { LogWriter } = require('../../src/writers/log-writer');
const {
  reportInteraction,
  reportInteractionErrorHandler,
} = require('../../src/middleware/report-interaction');

/**
 * The caller's source environment, from intake's authorize answer to the rows
 * the same request writes.
 *
 * `EndpointAuthorize` used to read only `deprecation` from the 201, and nothing
 * outside the tests called `RequestStore.setSourceApplicationEnvironmentId`. So
 * the response, log and error rows all carried
 * `source_application_environment_id: null`, intake stored that, and
 * app_portal's error page showed "—" for the Client of every error this SDK
 * reported (sc-473). Each half had a passing test of its own: the writers read
 * the store correctly, and the store held a value when a test put one there.
 *
 * So this drives the whole distance through real sockets: a real Express app
 * with `reportInteraction` around an `authorized` route, the SDK's real `fetch`
 * to a stub intake on loopback, and the rows those writers post back to the
 * same stub. The id has to be set on the request context the writers later read
 * from -- which for the response row is a `finish` listener on a real socket,
 * and for the error row is Express's error chain -- so a unit test that sets
 * and reads the store inside one `RequestStore.run` cannot see a break here.
 */

// `tests/setup/no-network.js` replaces `globalThis.fetch` in a `beforeEach` to
// fail any test that leaks a real outbound call. These calls go to a loopback
// port owned by this file, so it takes the real `fetch` back. Captured at
// module load, before any `beforeEach` has run.
const realFetch = globalThis.fetch;

/**
 * Intake's 201 body for a granted authorize (`AuthorizationJSON.show/1`): the
 * grant under `data`, with exactly these four keys. The stub names each caller's
 * environment after its credential, so a row that carries the wrong caller's id
 * is told apart from one that carries the right one.
 */
const grantFor = clientAuth => ({
  authorized: true,
  data: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      source_application_environment_id: `env-for-${clientAuth}`,
      target_application_environment_id: '33333333-3333-4333-8333-333333333333',
      inserted_at: '2026-09-10T00:00:00Z',
    },
  ],
});

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
      received.push({ url: req.url, body });

      const payload = req.url === '/api/authorize' ? grantFor(body.client_auth) : {};
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

/** A real client socket. */
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

function buildApp() {
  const app = express();

  app.use(reportInteraction);

  app.get('/books', authorized, (req, res) => {
    // Not awaited, as an application would write it.
    LogWriter.info('listing books');
    res.status(200).json({ books: [] });
  });

  app.get('/errors', authorized, () => {
    throw new Error('This is a test error for error tracking.');
  });

  app.use(reportInteractionErrorHandler);
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: err.message });
  });

  return app;
}

describe('authorized — the caller\'s source environment reaches the rows its request writes', () => {
  let intake;
  let appServer;
  let appPort;

  // The writers are fire-and-forget, so their rows land after the response
  // does. Wait for them rather than for a fixed interval.
  const rowsTo = fragment =>
    intake.received.filter(({ url }) => url.includes(fragment)).flatMap(({ body }) => body.payload);

  const eventually = async (predicate, what) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  const authorizeCalls = () => intake.received.filter(({ url }) => url === '/api/authorize');

  /** The uuid the SDK sent intake when it authorized this caller. */
  const uuidsFor = clientAuth =>
    authorizeCalls().filter(({ body }) => body.client_auth === clientAuth).map(({ body }) => body.uuid);

  beforeEach(async () => {
    globalThis.fetch = realFetch;

    jest.spyOn(console, 'error').mockImplementation(() => {});

    intake = await startStubIntake();

    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.baseUrl = `http://127.0.0.1:${intake.port}`;
    config.logBaseUrl = `http://127.0.0.1:${intake.port}`;
    authCache.clear();

    appServer = buildApp().listen(0, '127.0.0.1');
    await new Promise(resolve => appServer.once('listening', resolve));
    appPort = appServer.address().port;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    config._reset();
    authCache.clear();
    appServer.closeAllConnections?.();
    await new Promise(resolve => appServer.close(resolve));
    intake.server.closeAllConnections?.();
    await new Promise(resolve => intake.server.close(resolve));
  });

  test('the response and log rows name the caller', async () => {
    const response = await get(appPort, '/books', { authorization: 'Basic YWxpY2U=' });
    expect(response.status).toBe(200);

    await eventually(() => rowsTo('application_responses').length === 1, 'the response row');
    await eventually(() => rowsTo('application_logs').length === 1, 'the log row');

    const [responseRow] = rowsTo('application_responses');
    const [logRow] = rowsTo('application_logs');
    expect(responseRow.source_application_environment_id).toBe('env-for-Basic YWxpY2U=');
    expect(logRow.source_application_environment_id).toBe('env-for-Basic YWxpY2U=');
  });

  test('the error row names the caller', async () => {
    const response = await get(appPort, '/errors', { authorization: 'Basic YWxpY2U=' });
    expect(response.status).toBe(500);

    await eventually(() => rowsTo('application_errors').length === 1, 'the error row');
    await eventually(() => rowsTo('application_responses').length === 1, 'the response row');

    expect(rowsTo('application_errors')[0].source_application_environment_id)
      .toBe('env-for-Basic YWxpY2U=');
    expect(rowsTo('application_responses')[0].source_application_environment_id)
      .toBe('env-for-Basic YWxpY2U=');
  });

  test('so do the rows of a request the authorization cache answered', async () => {
    await get(appPort, '/errors', { authorization: 'Basic YWxpY2U=' });
    await get(appPort, '/errors', { authorization: 'Basic YWxpY2U=' });

    await eventually(() => rowsTo('application_errors').length === 2, 'both error rows');
    await eventually(() => rowsTo('application_responses').length === 2, 'both response rows');

    // One authorize call between them, so the second request's id can only
    // have come from the cache.
    expect(authorizeCalls()).toHaveLength(1);
    for (const row of [...rowsTo('application_errors'), ...rowsTo('application_responses')]) {
      expect(row.source_application_environment_id).toBe('env-for-Basic YWxpY2U=');
    }
  });

  test('concurrent callers each get their own', async () => {
    // The id lives on the request's AsyncLocalStorage context. Two callers in
    // flight at once must not see each other's, on the rows written from a
    // socket's `finish` event any more than on the ones written in the route.
    await Promise.all([
      get(appPort, '/books', { authorization: 'Basic YWxpY2U=' }),
      get(appPort, '/books', { authorization: 'Basic Ym9i' }),
    ]);

    await eventually(() => rowsTo('application_responses').length === 2, 'both response rows');
    await eventually(() => rowsTo('application_logs').length === 2, 'both log rows');

    const [aliceUuid] = uuidsFor('Basic YWxpY2U=');
    const [bobUuid] = uuidsFor('Basic Ym9i');
    expect(aliceUuid).toBeTruthy();
    expect(bobUuid).toBeTruthy();

    const expected = { [aliceUuid]: 'env-for-Basic YWxpY2U=', [bobUuid]: 'env-for-Basic Ym9i' };
    const rows = [...rowsTo('application_responses'), ...rowsTo('application_logs')];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.source_application_environment_id).toBe(expected[row.uuid]);
    }
  });
});
