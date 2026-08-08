'use strict';

/**
 * An index route mounted at a prefix produces `prefix + '/'` — so a router
 * mounted at `/books` with `router.get('/')` registered as `/books/`, while the
 * Rails SDK registers the same route as `/books`. intake stores whatever it is
 * told and matches exactly (`Intake.PathNormalizer` only rewrites `{var}` to
 * `:var`), so the two SDKs describe the same endpoint two different ways and
 * app_portal lists a path nobody calls.
 *
 * Registration and the authorize lookup must agree, or authorization breaks
 * outright — so both sides are pinned here.
 */

const express = require('express');
const { collectEndpoints } = require('../src/express/endpoint-registrar');
const { versioned } = require('../src/express/versioned');

function pathsFor(build) {
  const app = express();
  build(app);
  return collectEndpoints(app._router || app.router).map((e) => e.path);
}

describe('registered paths carry no trailing slash', () => {
  test('an index route on a mounted router registers without one', () => {
    const paths = pathsFor((app) => {
      const router = express.Router();
      router.get('/', versioned(['v1'], (req, res) => res.send('ok')));
      app.use('/books', router);
    });

    expect(paths).toContain('/books');
    expect(paths).not.toContain('/books/');
  });

  test('a nested route is unaffected', () => {
    const paths = pathsFor((app) => {
      const router = express.Router();
      router.get('/:id', versioned(['v1'], (req, res) => res.send('ok')));
      app.use('/books', router);
    });

    expect(paths).toContain('/books/:id');
  });

  test('a top-level route is unaffected', () => {
    const paths = pathsFor((app) => {
      app.get('/widgets', versioned(['v1'], (req, res) => res.send('ok')));
    });

    expect(paths).toContain('/widgets');
  });

  test('the root path stays "/" rather than becoming empty', () => {
    // Stripping unconditionally would turn the root route into "", which is not
    // a path any service can match.
    const paths = pathsFor((app) => {
      app.get('/', versioned(['v1'], (req, res) => res.send('ok')));
    });

    expect(paths).toContain('/');
    expect(paths).not.toContain('');
  });
});

describe('the authorize lookup agrees with what was registered', () => {
  // If these two disagree the SDK registers one path and asks about another,
  // and every request 401s with missing_target_endpoint.
  const { requestPath } = require('../src/express/request-path');

  test('an index route resolves to the registered form', () => {
    expect(requestPath({ baseUrl: '/books', route: { path: '/' } })).toBe('/books');
  });

  test('a nested route resolves unchanged', () => {
    expect(requestPath({ baseUrl: '/books', route: { path: '/:id' } })).toBe('/books/:id');
  });

  test('the root resolves to "/"', () => {
    expect(requestPath({ baseUrl: '', route: { path: '/' } })).toBe('/');
  });

  test('falls back to path or url when no route pattern is present', () => {
    expect(requestPath({ baseUrl: '', path: '/health/' })).toBe('/health');
    expect(requestPath({ baseUrl: '', url: '/health/' })).toBe('/health');
  });
});
