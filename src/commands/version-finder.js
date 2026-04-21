'use strict';

const { instance: config } = require('../configuration');

const VND_VERSION = /application\/vnd\.\w+\.v(\d+)/;
const X_API_VERSION = /v(\d+)/;
const PATH_VERSION = /\/v(\d+)\//;

/**
 * Finds the API version from an incoming request by checking multiple sources:
 *
 * 1. A custom `config.versionFinder` function if configured
 * 2. `Accept` header (e.g. `application/vnd.api.v1+json`)
 * 3. `X-Api-Version` header (e.g. `v1`)
 * 4. `Content-Type` header (e.g. `application/vnd.api.v1+json`)
 * 5. Query parameter `version` (e.g. `?version=v1`)
 * 6. URL path segment (e.g. `/v1/resource`)
 *
 * Returns the version number as a string (e.g. `"1"`) or `null`.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Commands::VersionFinder`.
 */
const VersionFinder = {
  /**
   * @param {object} req - Express `Request` or Node `IncomingMessage`.
   * @returns {string|null}
   */
  find(req) {
    if (config.versionFinder) {
      return config.versionFinder(req);
    }

    const headers = req.headers || {};
    const url = req.originalUrl || req.url || '';

    // Accept header
    let version = extract(headers.accept, VND_VERSION);
    if (version) return version;

    // X-Api-Version header
    version = extract(headers['x-api-version'], X_API_VERSION);
    if (version) return version;

    // Content-Type header
    version = extract(headers['content-type'], VND_VERSION);
    if (version) return version;

    // Query parameter
    version = versionFromQuery(url);
    if (version) return version;

    // Path segment
    const path = req.path || url.split('?')[0];
    version = extract(path, PATH_VERSION);
    return version;
  },
};

function extract(value, pattern) {
  if (!value) return null;
  const match = value.match(pattern);
  return match ? match[1] : null;
}

function versionFromQuery(url) {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return null;
  const query = url.slice(queryStart + 1);
  for (const part of query.split('&')) {
    if (part.startsWith('version=')) {
      const value = part.slice('version='.length);
      const match = value.match(X_API_VERSION);
      if (match) return match[1];
    }
  }
  return null;
}

module.exports = { VersionFinder };
