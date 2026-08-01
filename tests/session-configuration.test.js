'use strict';

const { SessionConfiguration } = require('../src/session-configuration');
const { instance: config } = require('../src/configuration');

// The environment name partitions every record in the portal, so guessing it
// wrong files production traffic under development or vice versa.
describe('SessionConfiguration.envName', () => {
  const original = { NODE_ENV: process.env.NODE_ENV, ENDPOINTBLANK_ENV: process.env.ENDPOINTBLANK_ENV };

  beforeEach(() => {
    config._reset();
    delete process.env.ENDPOINTBLANK_ENV;
  });

  afterEach(() => {
    config._reset();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('uses the explicitly configured environment', () => {
    config.environment = 'staging';
    process.env.NODE_ENV = 'development';

    expect(SessionConfiguration.envName()).toBe('staging');
  });

  test('falls back to NODE_ENV when nothing was configured', () => {
    process.env.NODE_ENV = 'development';

    expect(SessionConfiguration.envName()).toBe('development');
  });

  test('assumes production when nothing says otherwise', () => {
    // Erring towards production means an unconfigured deployment still files
    // its records somewhere real rather than into a dev bucket.
    delete process.env.NODE_ENV;

    expect(SessionConfiguration.envName()).toBe('production');
  });
});
