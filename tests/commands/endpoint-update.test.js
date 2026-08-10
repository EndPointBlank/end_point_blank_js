'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const os = require('os');
const pkg = require('../../package.json');
const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { EndpointUpdate } = require('../../src/commands/endpoint-update');

describe('EndpointUpdate', () => {
  const endpoints = [{ path: '/api/students', http_method: 'GET', endpoint_versions: ['v1'] }];

  const bodySent = () => post.mock.calls[0][2];

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.appName = 'billing';
    config.environment = 'staging';
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

  describe('the manifest it publishes', () => {
    test('goes to the application updates endpoint', async () => {
      await EndpointUpdate.sendUpdate(endpoints);

      expect(post.mock.calls[0][0]).toBe('https://epb.test/api/application_updates');
    });

    test('names the application and the environment being registered', async () => {
      await EndpointUpdate.sendUpdate(endpoints);

      expect(bodySent()).toMatchObject({ application: 'billing', environment: 'staging' });
    });

    test('carries the endpoint list it was given', async () => {
      await EndpointUpdate.sendUpdate(endpoints);

      expect(bodySent().endpoints).toEqual(endpoints);
    });

    test('identifies the host that is reporting', async () => {
      // One application runs on many hosts; the portal reconciles a manifest
      // per host rather than assuming they all deployed at once.
      await EndpointUpdate.sendUpdate(endpoints);

      expect(bodySent().hostname).toBe(os.hostname());
    });

    test('distinguishes the SDK version from the application version', async () => {
      // `lib_version` is this library; `app_version` is the customer's deploy.
      // A single unqualified `version` would conflate the two on ingest.
      config.applicationVersion = '2026.08.01';

      await EndpointUpdate.sendUpdate(endpoints);

      expect(bodySent().app_version).toBe('2026.08.01');
      expect(bodySent().lib_version).toBe(pkg.version);
    });

    test('reports the released library version, not a stale copy of it', async () => {
      // Asserted against package.json rather than against the constant the
      // payload is built from: this shipped `0.2.2` for two releases while the
      // package published `0.4.0`, and a self-referential assertion passed the
      // whole time. The portal answers "who is on which SDK version" from this
      // field, so it has to track what was actually released.
      await EndpointUpdate.sendUpdate(endpoints);

      expect(bodySent().lib_version).toBe(pkg.version);
    });

    test('sends an empty manifest when the caller has no endpoints to declare', async () => {
      // Meaningful in its own right: it retires endpoints that used to exist.
      await EndpointUpdate.sendUpdate();

      expect(bodySent().endpoints).toEqual([]);
    });

    test('authenticates with the configured client credentials', async () => {
      await EndpointUpdate.sendUpdate(endpoints);

      expect(post.mock.calls[0][1]).toMatch(/^Basic /);
    });
  });

  describe('when publishing does not succeed', () => {
    test('reports a rejection without throwing at the caller', async () => {
      // This runs from an app's `listen` callback; throwing would crash boot
      // over a telemetry problem.
      post.mockResolvedValue({ status: 422, ok: false, text: async () => 'unknown application' });

      await expect(EndpointUpdate.sendUpdate(endpoints)).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });

    test('gives up quietly when the service is unreachable', async () => {
      post.mockResolvedValue(null);

      await expect(EndpointUpdate.sendUpdate(endpoints)).resolves.toBeUndefined();
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  test('can be built and sent as an instance as well as through the shortcut', async () => {
    await new EndpointUpdate(endpoints).update();

    expect(bodySent().endpoints).toEqual(endpoints);
  });
});
