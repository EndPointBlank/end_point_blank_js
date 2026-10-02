'use strict';

/**
 * The management client against a real app_portal: skipped unless both
 * `EPB_MGMT_BASE_URL` (e.g. `http://localhost:4000`) and `EPB_MGMT_KEY` (a
 * write-scope `epb_mk_...` key) are set.
 *
 *   EPB_MGMT_BASE_URL=http://localhost:4000 EPB_MGMT_KEY=epb_mk_... npx jest tests/management/integration
 *
 * It creates what it uses, with a unique suffix, and removes it again. An
 * expected domain refusal (a plan limit, nothing deployed to put in a package)
 * is asserted by its code rather than failing the run.
 *
 * tests/setup/no-network.js replaces `globalThis.fetch` before every test, so
 * the real one is captured here, at load time, and handed to the client.
 */

const { ManagementClient, ManagementApiError, ErrorCode } = require('../../src/management');

const BASE_URL = process.env.EPB_MGMT_BASE_URL;
const KEY = process.env.EPB_MGMT_KEY;
const realFetch = globalThis.fetch;

const describeLive = BASE_URL && KEY ? describe : describe.skip;

/**
 * Runs `call`; answers `{value}`, or `{refused: code}` when it is refused with
 * one of `codes`. Any other failure is thrown.
 */
async function tolerate(call, codes) {
  try {
    return { value: await call() };
  } catch (err) {
    if (err instanceof ManagementApiError && codes.includes(err.code)) return { refused: err.code };
    throw err;
  }
}

describeLive('management API against a live app_portal', () => {
  jest.setTimeout(180_000);

  let mgmt;
  const cleanup = [];

  beforeAll(() => {
    mgmt = new ManagementClient({ apiKey: KEY, baseUrl: BASE_URL, fetch: realFetch });
  });

  afterAll(async () => {
    const failures = [];
    for (const [label, undo] of cleanup.reverse()) {
      try {
        await undo();
      } catch (err) {
        if (err instanceof ManagementApiError && err.code === ErrorCode.NOT_FOUND) continue;
        failures.push(`${label}: ${err.code || ''} ${err.message}`);
      }
    }
    if (failures.length > 0) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  });

  const later = (label, undo) => cleanup.push([label, undo]);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = (what) => `sdk-js-${what}-${suffix}`;

  test('the story flow', async () => {
    // Organization
    const organization = await mgmt.organization.get();
    expect(typeof organization.id).toBe('string');
    expect(organization.key.scope).toBe('write');

    // Environments, an application in one, then added to the second
    const environment = await mgmt.environments.create({ name: name('env'), domain: `${name('env')}.example.test` });
    later('environment', () => mgmt.environments.delete(environment.id));
    const second = await mgmt.environments.create({ name: name('env2'), domain: `${name('env2')}.example.test` });
    later('second environment', () => mgmt.environments.delete(second.id));

    const application = await mgmt.applications.create({
      name: name('app'),
      environment_base_urls: { [environment.id]: `https://${name('app')}.example.test` },
    });
    later('application', () => mgmt.applications.delete(application.id));
    expect(application.name).toBe(name('app'));

    const added = await mgmt.applications.environments.create(application.id, {
      environment_id: second.id,
      base_url: `https://${name('app')}-2.example.test`,
    });
    later('application environment', () => mgmt.applications.environments.delete(application.id, added.id));

    const appEnvironments = [];
    for await (const row of mgmt.applications.environments.listAll(application.id, { limit: 1 })) {
      appEnvironments.push(row);
    }
    expect(appEnvironments.map((row) => row.environment_id).sort()).toEqual([environment.id, second.id].sort());
    const appEnvironment = appEnvironments.find((row) => row.environment_id === environment.id);

    // An API package, with a deployed endpoint if there is one
    const apiPackage = await mgmt.apiPackages.create({ name: name('pkg') });
    later('API package', () => mgmt.apiPackages.delete(apiPackage.id));

    const { data: endpoints } = await mgmt.endpoints.list({ limit: 1 });
    let packageEnvironmentId = environment.id;
    if (endpoints.length > 0) {
      const [endpoint] = endpoints;
      const { data: deployedIn } = await mgmt.applications.environments.list(endpoint.application_id, { limit: 1 });
      if (deployedIn.length > 0) {
        packageEnvironmentId = deployedIn[0].environment_id;
        const result = await tolerate(
          () => mgmt.apiPackages.endpoints.add(apiPackage.id, {
            application_id: endpoint.application_id,
            endpoint_id: endpoint.id,
            environment_id: packageEnvironmentId,
          }),
          [ErrorCode.VALIDATION_FAILED],
        );
        if (result.value) {
          expect(result.value.data.api_package_id).toBe(apiPackage.id);
          expect(Array.isArray(result.value.warnings)).toBe(true);
          later('package endpoint', () => mgmt.apiPackages.endpoints.remove(apiPackage.id, result.value.data.id));
        }
      }
    }

    // Invite a client, and assign it the package if anything is published
    const invite = await tolerate(
      () => mgmt.clients.create({
        name: name('client'),
        contacts: [{ email: `${name('contact')}@example.test`, first_name: 'SDK', last_name: 'Test' }],
      }),
      [ErrorCode.PLAN_LIMIT],
    );
    if (invite.value) {
      const client = invite.value;
      later('client', () => mgmt.clients.delete(client.id));
      expect(client.status).toBe('pending');
      expect(client.managed).toBe(false);

      const assignment = await tolerate(
        () => mgmt.clients.packages.assign(client.id, { api_package_id: apiPackage.id, environment_id: packageEnvironmentId }),
        [ErrorCode.NOTHING_PUBLISHED_IN_ENVIRONMENT],
      );
      if (assignment.value) {
        expect(assignment.value.status).toBe('pending');
        later('assignment', () => mgmt.clients.packages.remove(client.id, assignment.value.id));
      }
    }

    // A credential: create, rotate, revoke
    const credential = await mgmt.credentials.create({ application_environment_id: appEnvironment.id });
    later('credential', () => mgmt.credentials.revoke(credential.id));
    expect(credential.client_secret).toEqual(expect.any(String));
    expect(credential.client_id.startsWith(`${organization.slug}.`) || !organization.slug).toBe(true);

    const rotated = await mgmt.credentials.rotate(credential.id);
    expect(rotated.id).toBe(credential.id);
    expect(rotated.client_secret).not.toBe(credential.client_secret);
    const listed = await mgmt.credentials.get(credential.id);
    expect(listed).not.toHaveProperty('client_secret');

    await expect(mgmt.credentials.revoke(credential.id)).resolves.toMatchObject({ id: credential.id, deleted: true });

    // A managed client, set up under /clients/:client_id/...
    const managed = await tolerate(() => mgmt.clients.create({ name: name('managed'), managed: true }), [ErrorCode.PLAN_LIMIT]);
    if (managed.value) {
      const managedClient = managed.value;
      later('managed client', () => mgmt.clients.delete(managedClient.id));
      expect(managedClient.managed).toBe(true);

      const scope = mgmt.forManagedClient(managedClient.id);
      const managedEnvironment = await scope.environments.create({ name: name('menv'), domain: `${name('menv')}.example.test` });
      later('managed environment', () => scope.environments.delete(managedEnvironment.id));
      const managedApp = await scope.applications.create({
        name: name('mapp'),
        environment_base_urls: { [managedEnvironment.id]: `https://${name('mapp')}.example.test` },
      });
      later('managed application', () => scope.applications.delete(managedApp.id));

      const { data: [managedAppEnvironment] } = await scope.applications.environments.list(managedApp.id);
      const managedCredential = await scope.credentials.create({ application_environment_id: managedAppEnvironment.id });
      later('managed credential', () => scope.credentials.revoke(managedCredential.id));
      expect(managedCredential.client_secret).toEqual(expect.any(String));

      await scope.credentials.revoke(managedCredential.id);
      await scope.applications.delete(managedApp.id);
      await scope.environments.delete(managedEnvironment.id);
      await expect(mgmt.clients.delete(managedClient.id)).resolves.toMatchObject({ id: managedClient.id, deleted: true });
    }
  });
});
