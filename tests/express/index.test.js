'use strict';

const express = require('express');

// `end-point-blank-js/express` is the import path the README documents, so a
// name that stops being re-exported here breaks every consumer regardless of
// whether the module behind it still works.
const epbExpress = require('../../src/express');

describe('the express entry point', () => {
  test('exposes the documented middleware', () => {
    expect(typeof epbExpress.authenticated).toBe('function');
    expect(typeof epbExpress.authorized).toBe('function');
    expect(typeof epbExpress.versioned).toBe('function');
  });

  test('exposes the documented registration helpers', () => {
    expect(typeof epbExpress.registerExpressEndpoints).toBe('function');
    expect(typeof epbExpress.collectEndpoints).toBe('function');
    expect(typeof epbExpress.getVersions).toBe('function');
  });

  test('the pieces it exports work together', () => {
    // Declaring a version through this entry point and collecting it through
    // the same one is the whole documented workflow.
    const app = express();
    app.get('/api/students', epbExpress.versioned(['v1']), (req, res) => res.json([]));

    expect(epbExpress.collectEndpoints(app._router)).toContainEqual({
      path: '/api/students',
      http_method: 'GET',
      endpoint_versions: ['v1'],
    });
  });
});
