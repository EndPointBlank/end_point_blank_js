'use strict';

const { EndpointUpdate } = require('../commands/endpoint-update');
const { getVersions } = require('./versioned');

/**
 * Inspects all registered Express routes and publishes the endpoint list to
 * the EndPointBlank API via {@link EndpointUpdate}.
 *
 * Equivalent to the Rails route-scanning logic in the Ruby gem's
 * `EndPointBlank::Commands::EndpointUpdate#endpoints`.
 *
 * Call once after your Express app is fully configured:
 * ```js
 * const { registerExpressEndpoints } = require('end-point-blank-js/express');
 *
 * app.listen(3000, () => registerExpressEndpoints(app));
 * ```
 *
 * @param {import('express').Application} app - The Express application instance.
 * @returns {Promise<void>}
 */
async function registerExpressEndpoints(app) {
  const endpoints = collectEndpoints(app._router);
  await EndpointUpdate.sendUpdate(endpoints);
  console.info(`[EndPointBlank] Registered ${endpoints.length} endpoints.`);
}

/**
 * Recursively walks an Express router's layer stack to collect route metadata.
 *
 * @param {object} router - Express Router instance.
 * @param {string} [prefix]
 * @returns {object[]}
 */
function collectEndpoints(router, prefix = '') {
  if (!router || !router.stack) return [];

  const endpoints = [];

  for (const layer of router.stack) {
    if (layer.route) {
      // A concrete route
      const path = prefix + (layer.route.path || '');
      const methods = Object.keys(layer.route.methods).filter(
        (m) => m !== '_all' && layer.route.methods[m],
      );

      // Look for _epbVersions on any handler in the stack
      const versions = layer.route.stack
        .map((l) => getVersions(l.handle))
        .reduce((acc, v) => Object.assign(acc, v), {});

      for (const method of methods) {
        endpoints.push({ path, http_method: method.toUpperCase(), endpoint_versions: versions });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      // A mounted sub-router
      const subPrefix = prefix + routerPrefix(layer);
      endpoints.push(...collectEndpoints(layer.handle, subPrefix));
    }
  }

  return endpoints;
}

function routerPrefix(layer) {
  if (!layer.regexp) return '';
  const source = layer.regexp.source;
  // Extract the path prefix from the compiled regex
  const match = source.match(/^\^\\?([\w/.-]+)/);
  return match ? match[1].replace(/\\\//g, '/') : '';
}

module.exports = { registerExpressEndpoints, collectEndpoints };
