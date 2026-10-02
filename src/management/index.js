'use strict';

/**
 * The EndPointBlank management API client: `require('end-point-blank-js/management')`.
 *
 * Kept out of the package's main entry point on purpose. The runtime client
 * (`configure()`, the Express guards, the writers) never loads it, and it
 * never loads the runtime configuration's values, so the two cannot share a
 * key or a base URL by accident.
 */

const { ManagementClient, DEFAULT_BASE_URL } = require('./client');
const { ManagementApiError, ErrorCode } = require('./errors');
const { ManagedClientScope } = require('./resources');
const { ConfigurationError } = require('../configuration');

module.exports = {
  ManagementClient,
  ManagementApiError,
  ErrorCode,
  ManagedClientScope,
  ConfigurationError,
  DEFAULT_BASE_URL,
};
