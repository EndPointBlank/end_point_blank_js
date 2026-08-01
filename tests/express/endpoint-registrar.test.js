'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const express = require('express');
const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { collectEndpoints, registerExpressEndpoints } = require('../../src/express/endpoint-registrar');
const { versioned } = require('../../src/express/versioned');

function makeApp() {
  const app = express();

  app.get('/api/v1/users', versioned(['v1', 'v2']), (req, res) => res.json([]));
  app.post('/api/v1/users', (req, res) => res.json({}));
  app.get('/api/v1/users/:id', versioned(['v1']), (req, res) => res.json({}));
  app.delete('/api/v1/users/:id', (req, res) => res.json({}));

  return app;
}

test('collectEndpoints returns routes from an Express app', () => {
  const app = makeApp();
  const endpoints = collectEndpoints(app._router);
  const paths = endpoints.map((e) => e.path);
  expect(paths).toContain('/api/v1/users');
  expect(paths).toContain('/api/v1/users/:id');
});

test('collectEndpoints includes HTTP method', () => {
  const app = makeApp();
  const endpoints = collectEndpoints(app._router);
  const getUsers = endpoints.find((e) => e.path === '/api/v1/users' && e.http_method === 'GET');
  expect(getUsers).toBeDefined();
  expect(getUsers.http_method).toBe('GET');
});

test('versioned metadata is included', () => {
  const app = makeApp();
  const endpoints = collectEndpoints(app._router);
  const route = endpoints.find((e) => e.path === '/api/v1/users' && e.http_method === 'GET');
  expect(route.endpoint_versions).toEqual(['v1', 'v2']);
});

test('routes without declared version metadata are skipped', () => {
  const app = makeApp();
  const endpoints = collectEndpoints(app._router);
  // POST /api/v1/users and DELETE /api/v1/users/:id have no versioned() wrapper,
  // so they are intentionally excluded from the published endpoint list.
  const post = endpoints.find((e) => e.path === '/api/v1/users' && e.http_method === 'POST');
  expect(post).toBeUndefined();
});

test('collects routes from mounted sub-routers', () => {
  const app = express();
  const router = express.Router();
  router.get('/items', versioned(['v1']), (req, res) => res.json([]));
  app.use('/api', router);

  const endpoints = collectEndpoints(app._router);
  const paths = endpoints.map((e) => e.path);
  expect(paths.some((p) => p.includes('items'))).toBe(true);
});

test('collectEndpoints returns nothing for an app with no routes', () => {
  // `registerExpressEndpoints` is documented as safe to call from `listen`,
  // which is reachable before any route has been mounted.
  expect(collectEndpoints(express()._router)).toEqual([]);
  expect(collectEndpoints(undefined)).toEqual([]);
});

describe('registerExpressEndpoints', () => {
  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.baseUrl = 'https://epb.test';
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  test('publishes the app\'s declared endpoints to the portal', async () => {
    await registerExpressEndpoints(makeApp());

    const published = post.mock.calls[0][2].endpoints;
    expect(published).toContainEqual({
      path: '/api/v1/users',
      http_method: 'GET',
      endpoint_versions: ['v1', 'v2'],
    });
  });

  test('publishes only the routes that declared a version', async () => {
    await registerExpressEndpoints(makeApp());

    const published = post.mock.calls[0][2].endpoints;
    expect(published.some((e) => e.http_method === 'POST')).toBe(false);
  });

  test('does not bring the app down when the portal is unreachable', async () => {
    // This is called from `app.listen`; an unhandled rejection here would take
    // out a boot that otherwise succeeded.
    post.mockResolvedValue(null);

    await expect(registerExpressEndpoints(makeApp())).resolves.toBeUndefined();
  });
});
