'use strict';

jest.mock('../../src/commands/basic-authenticate', () => ({
  BasicAuthenticate: { authenticate: jest.fn() },
}));
jest.mock('../../src/commands/endpoint-authorize', () => ({
  EndpointAuthorize: { authorize: jest.fn() },
}));

const http = require('http');
const express = require('express');

const { BasicAuthenticate } = require('../../src/commands/basic-authenticate');
const { EndpointAuthorize } = require('../../src/commands/endpoint-authorize');
const { authenticated, authorized, versioned, collectEndpoints } = require('../../src/express');

/**
 * The two guards must name the same endpoint, and it must be the one that was
 * registered.
 *
 * Intake resolves the endpoint row before it considers the credential, and
 * `Intake.Apis.get_endpoint/3` matches `path` with SQL `=` (`apis.ex:12-20`).
 * A path nothing was registered under resolves to no row, which is
 * `{:error, :missing_target_endpoint}` (`authorizations.ex:17`) rendered as a
 * 401 — so a path that disagrees by one prefix presents to the integrator as a
 * permissions problem on a credential that is perfectly good.
 *
 * `request-path.js` states the invariant and exists to hold it: "Registration
 * and authorization must produce byte-identical paths … hence one function,
 * used by both." `authorized` and the registrar call it; `authenticated` built
 * its own path and did not.
 *
 * Everything here is driven through a real Express app over a real socket, so
 * `req.baseUrl` and `req.route.path` are composed by Express rather than
 * supplied by the test. A hand-built `req` is exactly what missed this: the
 * bug lives in the fields Express fills in that the SDK forgot to read.
 */

/** A real client socket against the app under test. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path }, res => {
      let raw = '';
      res.on('data', chunk => {
        raw += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    request.on('error', reject);
  });
}

/**
 * The app both halves of each test see: the routes are declared once, so the
 * paths the guards report and the paths the registrar publishes come from the
 * same declarations rather than from two lists kept in step by hand.
 */
function buildApp() {
  const app = express();

  const students = express.Router();
  // The ordinary Express idiom: a router that knows nothing of where it is
  // mounted, so every path it declares is relative to a prefix it never sees.
  students.get('/', versioned(['v1']), authenticated, authorized, (req, res) => res.end('index'));
  students.get('/:id', versioned(['v1']), authenticated, authorized, (req, res) => res.end('show'));
  app.use('/students', students);

  // Mounted twice over, because `baseUrl` is the whole prefix rather than the
  // innermost one.
  const reports = express.Router();
  reports.get('/:id', versioned(['v1']), authenticated, authorized, (req, res) => res.end('report'));
  const api = express.Router();
  api.use('/reports', reports);
  app.use('/api', api);

  // Declared on the app itself, so there is no prefix to lose.
  app.get('/widgets/:id', versioned(['v1']), authenticated, authorized, (req, res) => res.end('w'));

  return app;
}

describe('the path the two guards ask intake about', () => {
  let server;
  let port;

  /** What each guard named, for one real request. */
  const askedAbout = async url => {
    await get(port, url);
    return {
      authenticate: BasicAuthenticate.authenticate.mock.calls[0]?.[1],
      authorize: EndpointAuthorize.authorize.mock.calls[0]?.[1],
    };
  };

  /** Every path the registrar would publish for this same app. */
  const registered = () => {
    const app = buildApp();
    return collectEndpoints(app._router || app.router).map(e => e.path);
  };

  beforeEach(async () => {
    BasicAuthenticate.authenticate.mockReset();
    EndpointAuthorize.authorize.mockReset();
    BasicAuthenticate.authenticate.mockResolvedValue({ status: 201 });
    EndpointAuthorize.authorize.mockResolvedValue({ status: 201 });

    server = buildApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  describe('a parameterized route on a router mounted under a prefix', () => {
    // The single most common shape in an Express app, and the one the SDK's
    // own README demonstrates.
    test('is named with the prefix by both guards', async () => {
      const asked = await askedAbout('/students/42');

      expect(asked.authenticate).toBe('/students/:id');
      expect(asked.authorize).toBe('/students/:id');
    });

    test('is named the way it was registered', async () => {
      const asked = await askedAbout('/students/42');

      expect(registered()).toContain(asked.authenticate);
    });
  });

  describe('an index route on a router mounted under a prefix', () => {
    // Express composes this one as `prefix + '/'`, which is the second half of
    // what `requestPath` does and the reason it does not simply concatenate.
    test('is named with the prefix and no trailing slash by both guards', async () => {
      const asked = await askedAbout('/students/');

      expect(asked.authenticate).toBe('/students');
      expect(asked.authorize).toBe('/students');
    });

    test('is named the way it was registered', async () => {
      const asked = await askedAbout('/students/');

      expect(registered()).toContain(asked.authenticate);
    });
  });

  describe('a route on a router mounted inside another router', () => {
    test('is named with the whole prefix by both guards', async () => {
      const asked = await askedAbout('/api/reports/7');

      expect(asked.authenticate).toBe('/api/reports/:id');
      expect(asked.authorize).toBe('/api/reports/:id');
    });
  });

  describe('a route declared on the app itself', () => {
    /**
     * The control, and the reason it is labelled as one: this passes with the
     * defect in place. `req.baseUrl` is `''` and the route pattern carries no
     * trailing slash, so building the path by hand happens to produce the same
     * string the shared helper does. A suite testing only this shape reports
     * green on a guard that cannot resolve an endpoint on any mounted router.
     */
    test('agrees either way, which is why the cases above are the test', async () => {
      const asked = await askedAbout('/widgets/7');

      expect(asked.authenticate).toBe('/widgets/:id');
      expect(asked.authorize).toBe('/widgets/:id');
    });
  });

  describe('the two guards, on every shape at once', () => {
    test.each([
      ['a parameterized route under a prefix', '/students/42'],
      ['an index route under a prefix', '/students/'],
      ['a route under two prefixes', '/api/reports/7'],
      ['a route on the app itself', '/widgets/7'],
    ])('name one endpoint identically for %s', async (_shape, url) => {
      // The invariant itself, stated without naming any expected string: the
      // guards may not disagree, whatever the right answer turns out to be.
      const asked = await askedAbout(url);

      expect(asked.authenticate).toBe(asked.authorize);
    });
  });
});
