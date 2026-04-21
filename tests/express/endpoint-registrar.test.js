'use strict';

const express = require('express');
const { collectEndpoints } = require('../../src/express/endpoint-registrar');
const { versioned } = require('../../src/express/versioned');

function makeApp() {
  const app = express();

  app.get('/api/v1/users', versioned(['v1', 'v2'], { state: 'Current' }), (req, res) => res.json([]));
  app.post('/api/v1/users', (req, res) => res.json({}));
  app.get('/api/v1/users/:id', versioned(['v1'], { state: 'Deprecated' }), (req, res) => res.json({}));
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
  const getUsers = endpoints.find((e) => e.path === '/api/v1/users' && e.action === 'GET');
  expect(getUsers).toBeDefined();
  expect(getUsers.action).toBe('GET');
});

test('versioned metadata is included', () => {
  const app = makeApp();
  const endpoints = collectEndpoints(app._router);
  const route = endpoints.find((e) => e.path === '/api/v1/users' && e.action === 'GET');
  expect(route.versions).toEqual({ Current: ['v1', 'v2'] });
});

test('routes without versioned metadata have empty versions', () => {
  const app = makeApp();
  const endpoints = collectEndpoints(app._router);
  const route = endpoints.find((e) => e.path === '/api/v1/users' && e.action === 'POST');
  expect(route.versions).toEqual({});
});

test('collects routes from mounted sub-routers', () => {
  const app = express();
  const router = express.Router();
  router.get('/items', (req, res) => res.json([]));
  app.use('/api', router);

  const endpoints = collectEndpoints(app._router);
  const paths = endpoints.map((e) => e.path);
  expect(paths.some((p) => p.includes('items'))).toBe(true);
});
