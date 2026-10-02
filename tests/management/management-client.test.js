'use strict';

const util = require('util');
const {
  ManagementClient,
  ManagementApiError,
  ErrorCode,
  ConfigurationError,
  DEFAULT_BASE_URL,
} = require('../../src/management');
const { VERSION } = require('../../src/version');

const KEY = 'epb_mk_test_0123456789abcdef';
const BASE = 'https://portal.example.test';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A fetch that answers from a queue and records every call. Each queued answer
 * is `{status, body, headers}` (body: object -> JSON, string -> as is) or an
 * Error to throw.
 */
function fakeFetch(...answers) {
  const queue = [...answers];
  const calls = [];
  const fetch = jest.fn(async (url, init) => {
    const parsed = new URL(url);
    calls.push({
      url,
      method: init.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const answer = queue.length > 0 ? queue.shift() : { status: 200, body: { data: {} } };
    if (answer instanceof Error) throw answer;
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(answer.status === 204 ? null : body, {
      status: answer.status || 200,
      headers: { 'content-type': 'application/json', ...(answer.headers || {}) },
    });
  });
  fetch.calls = calls;
  return fetch;
}

function client(fetch, options = {}) {
  const sleep = jest.fn(async () => {});
  const mgmt = new ManagementClient({ apiKey: KEY, baseUrl: BASE, fetch, sleep, ...options });
  return { mgmt, sleep };
}

const ok = (data, extra = {}) => ({ status: 200, body: { data, ...extra } });
const created = (data, extra = {}) => ({ status: 201, body: { data, ...extra } });
const apiError = (status, code, message = 'nope', details, headers) => ({
  status,
  body: { error: details === undefined ? { code, message } : { code, message, details } },
  headers,
});

async function caught(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('ManagementClient construction', () => {
  test('defaults the base URL to https://app.endpointblank.com', () => {
    const mgmt = new ManagementClient({ apiKey: KEY });
    expect(mgmt.baseUrl).toBe('https://app.endpointblank.com');
    expect(DEFAULT_BASE_URL).toBe('https://app.endpointblank.com');
  });

  test('takes a base URL override and drops a trailing slash', () => {
    expect(new ManagementClient({ apiKey: KEY, baseUrl: 'http://localhost:4000/' }).baseUrl)
      .toBe('http://localhost:4000');
  });

  test.each([
    ['https://app.endpointblank.com/api/v1'],
    ['https://app.endpointblank.com/api'],
    ['ftp://app.endpointblank.com'],
    ['not a url'],
    ['https://user:pass@app.endpointblank.com'],
    ['https://app.endpointblank.com?x=1'],
  ])('refuses the base URL %s', (baseUrl) => {
    expect(() => new ManagementClient({ apiKey: KEY, baseUrl })).toThrow(ConfigurationError);
  });

  test('refuses a missing key', () => {
    expect(() => new ManagementClient({})).toThrow(/needs apiKey/);
  });

  test('refuses a key that is not epb_mk_ without echoing it', () => {
    const runtimeSecret = 'super-secret-runtime-value';
    let error;
    try {
      new ManagementClient({ apiKey: runtimeSecret });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toMatch(/must start with "epb_mk_"/);
    expect(error.message).not.toContain(runtimeSecret);
  });

  test.each([['epb_mk_'], ['epb_mk_ has space'], [42]])('refuses the malformed key %p', (apiKey) => {
    expect(() => new ManagementClient({ apiKey })).toThrow(ConfigurationError);
  });

  test('refuses an unknown option, such as a runtime clientSecret', () => {
    expect(() => new ManagementClient({ apiKey: KEY, clientSecret: 'x' }))
      .toThrow(/unknown option\(s\): clientSecret/);
  });

  test.each([
    [{ maxRetries: -1 }],
    [{ maxRetries: 1.5 }],
    [{ timeoutMs: 0 }],
    [{ fetch: 'nope' }],
    [{ sleep: 1 }],
  ])('refuses the invalid option %p', (opts) => {
    expect(() => new ManagementClient({ apiKey: KEY, ...opts })).toThrow(ConfigurationError);
  });
});

describe('the management key is never shown', () => {
  test('not by inspect, JSON or String, on the client or its resources', () => {
    const { mgmt } = client(fakeFetch());
    const views = [
      util.inspect(mgmt, { depth: 10, showHidden: true }),
      JSON.stringify(mgmt),
      String(mgmt),
      `${mgmt}`,
      util.inspect(mgmt.clients, { depth: 10, showHidden: true }),
      util.inspect(mgmt.forManagedClient('c1'), { depth: 10, showHidden: true }),
    ];
    for (const view of views) {
      expect(view).not.toContain(KEY);
      expect(view).not.toContain('0123456789abcdef');
    }
    expect(util.inspect(mgmt)).toContain('[REDACTED]');
  });

  test('not on an error, in its message or any field', async () => {
    const { mgmt } = client(fakeFetch(apiError(401, 'invalid_key', 'The management API key is invalid.')));
    const error = await caught(mgmt.organization.get());
    expect(error).toBeInstanceOf(ManagementApiError);
    expect(util.inspect(error, { depth: 10 })).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
  });
});

describe('request headers', () => {
  test('sends the key as Bearer, Accept, and a User-Agent naming the SDK version', async () => {
    const fetch = fakeFetch(ok({ id: 'o1' }));
    const { mgmt } = client(fetch);

    await mgmt.organization.get();

    const { headers, url } = fetch.calls[0];
    expect(url).toBe(`${BASE}/api/v1/organization`);
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toBe(`end-point-blank-js/${VERSION} (management)`);
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  test('sends Content-Type with a body', async () => {
    const fetch = fakeFetch(ok({ id: 'p1' }));
    const { mgmt } = client(fetch);
    await mgmt.apiPackages.update('p1', { name: 'n' });
    expect(fetch.calls[0].headers['Content-Type']).toBe('application/json');
  });

  test('never sends the runtime client credentials, even when configure() has them', async () => {
    const epb = require('../../src');
    const { config } = epb;
    const before = { clientId: config._clientId, clientSecret: config._clientSecret };
    epb.configure({ clientId: 'acme.runtime-id', clientSecret: 'runtime-secret-value' });
    try {
      const fetch = fakeFetch(ok({ id: 'o1' }), created({ id: 'c1', client_secret: 's' }));
      const { mgmt } = client(fetch);
      await mgmt.organization.get();
      await mgmt.credentials.create({ application_environment_id: 'ae1' });

      for (const call of fetch.calls) {
        expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
        const wire = JSON.stringify(call);
        expect(wire).not.toContain('runtime-secret-value');
        expect(wire).not.toContain('acme.runtime-id');
        expect(wire).not.toMatch(/Basic /);
      }
    } finally {
      config._clientId = before.clientId;
      config._clientSecret = before.clientSecret;
    }
  });
});

describe('every resource method', () => {
  // [label, call, method, path, body, query]
  const cases = [
    ['organization.get', (m) => m.organization.get(), 'GET', '/organization'],

    ['apiPackages.list', (m) => m.apiPackages.list({ limit: 10, after: 'cur' }), 'GET', '/api_packages', undefined, { limit: '10', after: 'cur' }],
    ['apiPackages.create', (m) => m.apiPackages.create({ name: 'Gold' }), 'POST', '/api_packages', { name: 'Gold' }],
    ['apiPackages.get', (m) => m.apiPackages.get('p1'), 'GET', '/api_packages/p1'],
    ['apiPackages.update', (m) => m.apiPackages.update('p1', { name: 'Silver' }), 'PATCH', '/api_packages/p1', { name: 'Silver' }],
    ['apiPackages.delete', (m) => m.apiPackages.delete('p1'), 'DELETE', '/api_packages/p1'],
    ['apiPackages.endpoints.list', (m) => m.apiPackages.endpoints.list('p1'), 'GET', '/api_packages/p1/endpoints'],
    ['apiPackages.endpoints.add', (m) => m.apiPackages.endpoints.add('p1', { application_id: 'a1', environment_id: 'e1' }), 'POST', '/api_packages/p1/endpoints', { application_id: 'a1', environment_id: 'e1' }],
    ['apiPackages.endpoints.remove', (m) => m.apiPackages.endpoints.remove('p1', 'acc1'), 'DELETE', '/api_packages/p1/endpoints/acc1'],

    ['endpoints.list', (m) => m.endpoints.list({ application_id: 'a1', version: '1.0.0' }), 'GET', '/endpoints', undefined, { application_id: 'a1', version: '1.0.0' }],

    ['clients.list', (m) => m.clients.list(), 'GET', '/clients'],
    ['clients.create', (m) => m.clients.create({ name: 'Acme', contacts: [{ email: 'a@acme.test', first_name: 'A', last_name: 'B' }], packages: [{ api_package_id: 'p1', environment_id: 'e1' }], grants: [{ target_application_id: 'a1', environment_id: 'e1' }] }), 'POST', '/clients', { name: 'Acme', contacts: [{ email: 'a@acme.test', first_name: 'A', last_name: 'B' }], packages: [{ api_package_id: 'p1', environment_id: 'e1' }], grants: [{ target_application_id: 'a1', environment_id: 'e1' }] }],
    ['clients.create managed', (m) => m.clients.create({ name: 'Acme', managed: true }), 'POST', '/clients', { name: 'Acme', managed: true }],
    ['clients.get', (m) => m.clients.get('c1'), 'GET', '/clients/c1'],
    ['clients.delete', (m) => m.clients.delete('c1'), 'DELETE', '/clients/c1'],
    ['clients.claimInvite', (m) => m.clients.claimInvite('c1', { email: 'owner@acme.test' }), 'POST', '/clients/c1/claim_invites', { email: 'owner@acme.test' }],
    ['clients.packages.list', (m) => m.clients.packages.list('c1'), 'GET', '/clients/c1/packages'],
    ['clients.packages.assign', (m) => m.clients.packages.assign('c1', { api_package_id: 'p1', environment_id: 'e1' }), 'POST', '/clients/c1/packages', { api_package_id: 'p1', environment_id: 'e1' }],
    ['clients.packages.update', (m) => m.clients.packages.update('c1', 'as1', { environment_id: 'e2' }), 'PATCH', '/clients/c1/packages/as1', { environment_id: 'e2' }],
    ['clients.packages.remove', (m) => m.clients.packages.remove('c1', 'as1'), 'DELETE', '/clients/c1/packages/as1'],
    ['clients.grants.list', (m) => m.clients.grants.list('c1'), 'GET', '/clients/c1/grants'],
    ['clients.grants.create', (m) => m.clients.grants.create('c1', { target_application_id: 'a1', target_endpoint_id: 'ep1', environment_id: 'e1' }), 'POST', '/clients/c1/grants', { target_application_id: 'a1', target_endpoint_id: 'ep1', environment_id: 'e1' }],
    ['clients.grants.revoke', (m) => m.clients.grants.revoke('c1', 'g1'), 'DELETE', '/clients/c1/grants/g1'],

    ['applications.list', (m) => m.applications.list(), 'GET', '/applications'],
    ['applications.create', (m) => m.applications.create({ name: 'Orders', environment_base_urls: { e1: 'https://orders.test' } }), 'POST', '/applications', { name: 'Orders', environment_base_urls: { e1: 'https://orders.test' } }],
    ['applications.get', (m) => m.applications.get('a1'), 'GET', '/applications/a1'],
    ['applications.update', (m) => m.applications.update('a1', { public: true }), 'PATCH', '/applications/a1', { public: true }],
    ['applications.delete', (m) => m.applications.delete('a1'), 'DELETE', '/applications/a1'],
    ['applications.environments.list', (m) => m.applications.environments.list('a1'), 'GET', '/applications/a1/environments'],
    ['applications.environments.create', (m) => m.applications.environments.create('a1', { environment_id: 'e1', base_url: 'https://x.test' }), 'POST', '/applications/a1/environments', { environment_id: 'e1', base_url: 'https://x.test' }],
    ['applications.environments.delete', (m) => m.applications.environments.delete('a1', 'ae1'), 'DELETE', '/applications/a1/environments/ae1'],

    ['environments.list', (m) => m.environments.list(), 'GET', '/environments'],
    ['environments.create', (m) => m.environments.create({ name: 'staging', domain: 'staging.test' }), 'POST', '/environments', { name: 'staging', domain: 'staging.test' }],
    ['environments.get', (m) => m.environments.get('e1'), 'GET', '/environments/e1'],
    ['environments.update', (m) => m.environments.update('e1', { is_default: true }), 'PATCH', '/environments/e1', { is_default: true }],
    ['environments.delete', (m) => m.environments.delete('e1'), 'DELETE', '/environments/e1'],

    ['credentials.list', (m) => m.credentials.list({ application_environment_id: 'ae1' }), 'GET', '/credentials', undefined, { application_environment_id: 'ae1' }],
    ['credentials.get', (m) => m.credentials.get('cr1'), 'GET', '/credentials/cr1'],
    ['credentials.create', (m) => m.credentials.create({ application_environment_id: 'ae1' }), 'POST', '/credentials', { application_environment_id: 'ae1' }],
    ['credentials.rotate', (m) => m.credentials.rotate('cr1'), 'POST', '/credentials/cr1/rotate'],
    ['credentials.revoke', (m) => m.credentials.revoke('cr1'), 'DELETE', '/credentials/cr1'],
  ];

  // Padded to one length: jest.each hands a short row's missing slot `done`.
  const rows = cases.map(([label, call, method, path, body, query]) => [label, call, method, path, body, query || {}]);

  test.each(rows)('%s', async (_label, call, method, path, body, query) => {
    const fetch = fakeFetch(ok({ id: 'x' }, { next_cursor: null }));
    const { mgmt } = client(fetch);

    await call(mgmt);

    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = fetch.calls[0];
    expect(sent.method).toBe(method);
    expect(sent.path).toBe(`/api/v1${path}`);
    expect(sent.query).toEqual(query);
    expect(sent.body).toEqual(body);
    if (method === 'POST') {
      expect(sent.headers['Idempotency-Key']).toMatch(UUID_V4);
    } else {
      expect(sent.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  test('a single resource answers its data object', async () => {
    const { mgmt } = client(fakeFetch(ok({ id: 'p1', name: 'Gold' })));
    await expect(mgmt.apiPackages.get('p1')).resolves.toEqual({ id: 'p1', name: 'Gold' });
  });

  test('a delete answers its data object', async () => {
    const { mgmt } = client(fakeFetch(ok({ id: 'g1', deleted: true, still_granted_by_package: true })));
    await expect(mgmt.clients.grants.revoke('c1', 'g1'))
      .resolves.toEqual({ id: 'g1', deleted: true, still_granted_by_package: true });
  });

  test('adding a package endpoint answers data and warnings', async () => {
    const warnings = [{ code: 'assignment_derives_nothing', message: 'm', client_organization_id: 'o', environment_id: 'e' }];
    const { mgmt } = client(fakeFetch(created({ id: 'acc1' }, { warnings })));
    await expect(mgmt.apiPackages.endpoints.add('p1', { application_id: 'a1', environment_id: 'e1' }))
      .resolves.toEqual({ data: { id: 'acc1' }, warnings });
  });

  test('a credential create answers the one-time secret to the caller and logs nothing', async () => {
    const secret = 'one-time-secret-value';
    const writes = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => writes.push(String(chunk)) && true);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => writes.push(String(chunk)) && true);
    const consoles = ['log', 'info', 'warn', 'error', 'debug'].map((name) => jest.spyOn(console, name).mockImplementation(() => {}));
    try {
      const { mgmt } = client(fakeFetch(created({ id: 'cr1', client_secret: secret })));
      const credential = await mgmt.credentials.create({ application_environment_id: 'ae1' });
      expect(credential.client_secret).toBe(secret);
      for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
      expect(writes.join('')).not.toContain(secret);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      consoles.forEach((spy) => spy.mockRestore());
    }
  });

  test('ids are path-encoded', async () => {
    const fetch = fakeFetch(ok({}));
    const { mgmt } = client(fetch);
    await mgmt.clients.get('a/b?c');
    expect(fetch.calls[0].url).toBe(`${BASE}/api/v1/clients/a%2Fb%3Fc`);
  });

  test('a missing id is refused before any request', () => {
    const fetch = fakeFetch();
    const { mgmt } = client(fetch);
    expect(() => mgmt.clients.get(undefined)).toThrow(TypeError);
    expect(() => mgmt.forManagedClient('')).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('managed clients', () => {
  // [label, call, method, path]
  const cases = [
    ['applications.list', (s) => s.applications.list(), 'GET', '/applications'],
    ['applications.create', (s) => s.applications.create({ name: 'A', environment_base_urls: { e1: 'https://a.test' } }), 'POST', '/applications'],
    ['applications.get', (s) => s.applications.get('a1'), 'GET', '/applications/a1'],
    ['applications.update', (s) => s.applications.update('a1', { name: 'B' }), 'PATCH', '/applications/a1'],
    ['applications.delete', (s) => s.applications.delete('a1'), 'DELETE', '/applications/a1'],
    ['applications.environments.list', (s) => s.applications.environments.list('a1'), 'GET', '/applications/a1/environments'],
    ['applications.environments.create', (s) => s.applications.environments.create('a1', { environment_id: 'e1', base_url: 'https://a.test' }), 'POST', '/applications/a1/environments'],
    ['applications.environments.delete', (s) => s.applications.environments.delete('a1', 'ae1'), 'DELETE', '/applications/a1/environments/ae1'],
    ['environments.list', (s) => s.environments.list(), 'GET', '/environments'],
    ['environments.create', (s) => s.environments.create({ name: 'qa', domain: 'qa.test' }), 'POST', '/environments'],
    ['environments.get', (s) => s.environments.get('e1'), 'GET', '/environments/e1'],
    ['environments.update', (s) => s.environments.update('e1', { name: 'qa2' }), 'PATCH', '/environments/e1'],
    ['environments.delete', (s) => s.environments.delete('e1'), 'DELETE', '/environments/e1'],
    ['credentials.list', (s) => s.credentials.list(), 'GET', '/credentials'],
    ['credentials.get', (s) => s.credentials.get('cr1'), 'GET', '/credentials/cr1'],
    ['credentials.create', (s) => s.credentials.create({ application_environment_id: 'ae1' }), 'POST', '/credentials'],
    ['credentials.rotate', (s) => s.credentials.rotate('cr1'), 'POST', '/credentials/cr1/rotate'],
    ['credentials.revoke', (s) => s.credentials.revoke('cr1'), 'DELETE', '/credentials/cr1'],
    ['claimInvite', (s) => s.claimInvite({ email: 'o@acme.test' }), 'POST', '/claim_invites'],
  ];

  test.each(cases)('forManagedClient(id).%s is scoped under /clients/:client_id', async (_label, call, method, path) => {
    const fetch = fakeFetch({ status: 200, body: { data: [], next_cursor: null } });
    const { mgmt } = client(fetch);

    await call(mgmt.forManagedClient('mc1'));

    expect(fetch.calls[0].method).toBe(method);
    expect(fetch.calls[0].path).toBe(`/api/v1/clients/mc1${path}`);
    expect(fetch.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  test('the scope keeps its client id', () => {
    const { mgmt } = client(fakeFetch());
    expect(mgmt.forManagedClient('mc1').clientId).toBe('mc1');
  });
});

describe('pagination', () => {
  const pages = () => [
    { status: 200, body: { data: [{ id: 1 }, { id: 2 }], next_cursor: 'c1' } },
    { status: 200, body: { data: [{ id: 3 }, { id: 4 }], next_cursor: 'c2' } },
    { status: 200, body: { data: [{ id: 5 }], next_cursor: null } },
  ];

  test('list answers one page with next_cursor', async () => {
    const fetch = fakeFetch(pages()[0]);
    const { mgmt } = client(fetch);
    await expect(mgmt.clients.list({ limit: 2 }))
      .resolves.toEqual({ data: [{ id: 1 }, { id: 2 }], next_cursor: 'c1' });
  });

  test('listAll follows next_cursor over every page', async () => {
    const fetch = fakeFetch(...pages());
    const { mgmt } = client(fetch);

    const ids = [];
    for await (const item of mgmt.clients.listAll({ limit: 2 })) ids.push(item.id);

    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(fetch.calls.map((c) => c.query)).toEqual([
      { limit: '2' },
      { limit: '2', after: 'c1' },
      { limit: '2', after: 'c2' },
    ]);
  });

  test('pages yields each page, and stopping early fetches no more', async () => {
    const fetch = fakeFetch(...pages());
    const { mgmt } = client(fetch);

    const seen = [];
    for await (const page of mgmt.credentials.pages({ application_environment_id: 'ae1' })) {
      seen.push(page.next_cursor);
      if (seen.length === 2) break;
    }

    expect(seen).toEqual(['c1', 'c2']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.calls[1].query).toEqual({ application_environment_id: 'ae1', after: 'c1' });
  });

  // [label, resource getter, args before params, path]
  const lists = [
    ['apiPackages', (m) => m.apiPackages, [], '/api_packages'],
    ['apiPackages.endpoints', (m) => m.apiPackages.endpoints, ['p1'], '/api_packages/p1/endpoints'],
    ['endpoints', (m) => m.endpoints, [], '/endpoints'],
    ['clients', (m) => m.clients, [], '/clients'],
    ['clients.packages', (m) => m.clients.packages, ['c1'], '/clients/c1/packages'],
    ['clients.grants', (m) => m.clients.grants, ['c1'], '/clients/c1/grants'],
    ['applications', (m) => m.applications, [], '/applications'],
    ['applications.environments', (m) => m.applications.environments, ['a1'], '/applications/a1/environments'],
    ['environments', (m) => m.environments, [], '/environments'],
    ['credentials', (m) => m.credentials, [], '/credentials'],
    ['managed applications', (m) => m.forManagedClient('mc1').applications, [], '/clients/mc1/applications'],
    ['managed environments', (m) => m.forManagedClient('mc1').environments, [], '/clients/mc1/environments'],
    ['managed credentials', (m) => m.forManagedClient('mc1').credentials, [], '/clients/mc1/credentials'],
  ];

  test.each(lists)('%s.listAll and .pages walk every page of the right path', async (_label, resource, args, path) => {
    const fetch = fakeFetch(...pages(), ...pages());
    const { mgmt } = client(fetch);

    const items = [];
    for await (const item of resource(mgmt).listAll(...args, { limit: 2 })) items.push(item.id);
    const cursors = [];
    for await (const page of resource(mgmt).pages(...args, { limit: 2 })) cursors.push(page.next_cursor);

    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(cursors).toEqual(['c1', 'c2', null]);
    expect(new Set(fetch.calls.map((c) => c.path))).toEqual(new Set([`/api/v1${path}`]));
  });

  test('nested lists page too', async () => {
    const fetch = fakeFetch(...pages());
    const { mgmt } = client(fetch);
    const all = [];
    for await (const grant of mgmt.clients.grants.listAll('c1')) all.push(grant);
    expect(all).toHaveLength(5);
    expect(new Set(fetch.calls.map((c) => c.path))).toEqual(new Set(['/api/v1/clients/c1/grants']));
  });

  test('a repeated next_cursor stops instead of looping forever', async () => {
    const same = { status: 200, body: { data: [{ id: 1 }], next_cursor: 'same' } };
    const { mgmt } = client(fakeFetch(same, same, same));
    await expect((async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of mgmt.environments.listAll()) { /* drain */ }
    })()).rejects.toThrow(/same next_cursor twice/);
  });

  test.each([[0], [101], [1.5], ['10']])('refuses limit %p before any request', async (limit) => {
    const fetch = fakeFetch();
    const { mgmt } = client(fetch);
    await expect(mgmt.applications.list({ limit })).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('idempotency keys', () => {
  test('each POST gets its own generated UUID v4', async () => {
    const fetch = fakeFetch(created({}), created({}));
    const { mgmt } = client(fetch);
    await mgmt.apiPackages.create({ name: 'a' });
    await mgmt.apiPackages.create({ name: 'a' });
    const [first, second] = fetch.calls.map((c) => c.headers['Idempotency-Key']);
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  test('the caller can pass one', async () => {
    const fetch = fakeFetch(created({}));
    const { mgmt } = client(fetch);
    await mgmt.clients.create({ name: 'Acme' }, { idempotencyKey: 'invite-acme-1' });
    expect(fetch.calls[0].headers['Idempotency-Key']).toBe('invite-acme-1');
  });

  test('a generated key is reused on every retry', async () => {
    const fetch = fakeFetch(
      apiError(503, 'intake_unavailable'),
      apiError(429, 'rate_limited', 'slow down', undefined, { 'retry-after': '1' }),
      created({ id: 'cr1', client_secret: 's' }),
    );
    const { mgmt } = client(fetch);

    await mgmt.credentials.create({ application_environment_id: 'ae1' });

    const keys = fetch.calls.map((c) => c.headers['Idempotency-Key']);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(UUID_V4);
    expect(new Set(keys).size).toBe(1);
  });

  test('a caller key is reused on retry', async () => {
    const fetch = fakeFetch(new TypeError('fetch failed'), created({}));
    const { mgmt } = client(fetch);
    await mgmt.credentials.rotate('cr1', { idempotencyKey: 'rotate-cr1' });
    expect(fetch.calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['rotate-cr1', 'rotate-cr1']);
  });

  test.each([[''], ['   '], ['x'.repeat(256)], [42]])('refuses the key %p before any request', async (idempotencyKey) => {
    const fetch = fakeFetch();
    const { mgmt } = client(fetch);
    await expect(mgmt.apiPackages.create({ name: 'a' }, { idempotencyKey })).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('idempotency_request_in_progress is retried with the same key', async () => {
    const fetch = fakeFetch(apiError(409, 'idempotency_request_in_progress'), created({ id: 'p1' }));
    const { mgmt, sleep } = client(fetch);
    await expect(mgmt.apiPackages.create({ name: 'a' })).resolves.toEqual({ id: 'p1' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(fetch.calls[1].headers['Idempotency-Key']).toBe(fetch.calls[0].headers['Idempotency-Key']);
  });

  test('idempotency_replay_unavailable is not retried and says to read the resource', async () => {
    const fetch = fakeFetch(apiError(
      409,
      'idempotency_replay_unavailable',
      'A request with this Idempotency-Key already completed.',
      undefined,
      { location: '/api/v1/credentials/cr1' },
    ));
    const { mgmt, sleep } = client(fetch);

    const error = await caught(mgmt.credentials.create({ application_environment_id: 'ae1' }, { idempotencyKey: 'k1' }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error.code).toBe(ErrorCode.IDEMPOTENCY_REPLAY_UNAVAILABLE);
    expect(error.status).toBe(409);
    expect(error.location).toBe('/api/v1/credentials/cr1');
    expect(error.idempotencyKey).toBe('k1');
    expect(error.message).toMatch(/Read or list the resource.*\/api\/v1\/credentials\/cr1/);
  });
});

describe('errors', () => {
  test('404 not_found', async () => {
    const { mgmt } = client(fakeFetch({ ...apiError(404, 'not_found', 'Not found.'), headers: { 'x-request-id': 'req-1' } }));
    const error = await caught(mgmt.clients.get('missing'));
    expect(error).toBeInstanceOf(ManagementApiError);
    expect(error).toMatchObject({
      name: 'ManagementApiError',
      code: 'not_found',
      message: 'Not found.',
      status: 404,
      details: null,
      method: 'GET',
      path: '/api/v1/clients/missing',
      idempotencyKey: null,
      requestId: 'req-1',
    });
  });

  test('422 validation_failed carries details', async () => {
    const details = { name: ["can't be blank"] };
    const { mgmt } = client(fakeFetch(apiError(422, 'validation_failed', 'The request has invalid fields.', details)));
    const error = await caught(mgmt.apiPackages.create({ name: '' }));
    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(error.status).toBe(422);
    expect(error.details).toEqual(details);
  });

  test('402 plan_limit', async () => {
    const fetch = fakeFetch(apiError(402, 'plan_limit', "Your plan's limit for this resource is reached."));
    const { mgmt } = client(fetch);
    const error = await caught(mgmt.clients.create({ name: 'One too many' }));
    expect(error.code).toBe(ErrorCode.PLAN_LIMIT);
    expect(error.status).toBe(402);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('an unknown code still surfaces as itself', async () => {
    const { mgmt } = client(fakeFetch(apiError(422, 'brand_new_refusal', 'Something new.', { why: 'x' })));
    const error = await caught(mgmt.environments.delete('e1'));
    expect(error.code).toBe('brand_new_refusal');
    expect(error.message).toBe('Something new.');
    expect(error.details).toEqual({ why: 'x' });
  });

  test('a non-JSON error body is an http_error with the status and a snippet', async () => {
    const fetch = fakeFetch(
      { status: 502, body: '<html>Bad Gateway</html>', headers: { 'content-type': 'text/html' } },
      { status: 502, body: '<html>Bad Gateway</html>', headers: { 'content-type': 'text/html' } },
    );
    const { mgmt } = client(fetch, { maxRetries: 1 });
    const error = await caught(mgmt.organization.get());
    expect(error.code).toBe(ErrorCode.HTTP_ERROR);
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/GET \/api\/v1\/organization answered 502.*Bad Gateway/);
    expect(error.details).toEqual({ body: '<html>Bad Gateway</html>' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('an empty error body is an http_error too', async () => {
    const { mgmt } = client(fakeFetch({ status: 404, body: '' }));
    const error = await caught(mgmt.organization.get());
    expect(error).toMatchObject({ code: 'http_error', status: 404, details: null });
  });

  test('a success without a JSON object is invalid_response', async () => {
    const { mgmt } = client(fakeFetch({ status: 200, body: 'ok' }));
    const error = await caught(mgmt.organization.get());
    expect(error).toMatchObject({ code: ErrorCode.INVALID_RESPONSE, status: 200 });
  });

  test('a request that never completes is network_error with no status', async () => {
    const fetch = fakeFetch(new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'));
    const { mgmt, sleep } = client(fetch);
    const error = await caught(mgmt.clients.list());
    expect(error).toMatchObject({ code: ErrorCode.NETWORK_ERROR, status: null, method: 'GET' });
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  test('anything fetch throws that is not a network error is thrown as itself, not retried', async () => {
    const bug = new RangeError('bug');
    const fetch = fakeFetch(bug);
    const { mgmt } = client(fetch);
    await expect(mgmt.clients.list()).rejects.toBe(bug);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('ErrorCode lists the documented codes', () => {
    expect(ErrorCode.RATE_LIMITED).toBe('rate_limited');
    expect(ErrorCode.INTAKE_UNAVAILABLE).toBe('intake_unavailable');
    expect(ErrorCode.DELETE_REFUSED).toBe('delete_refused');
    expect(ErrorCode.INSUFFICIENT_SCOPE).toBe('insufficient_scope');
    expect(Object.values(ErrorCode)).not.toContain('unsupported_media_type');
    expect(Object.isFrozen(ErrorCode)).toBe(true);
  });
});

describe('retries', () => {
  test('429 waits Retry-After seconds, then succeeds', async () => {
    const fetch = fakeFetch(
      apiError(429, 'rate_limited', 'Too many requests.', undefined, { 'retry-after': '7' }),
      ok({ id: 'o1' }),
    );
    const { mgmt, sleep } = client(fetch);

    await expect(mgmt.organization.get()).resolves.toEqual({ id: 'o1' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  test('429 is retried for a PATCH too: the server refused it before running it', async () => {
    const fetch = fakeFetch(apiError(429, 'rate_limited', 'x', undefined, { 'retry-after': '1' }), ok({ id: 'a1' }));
    const { mgmt } = client(fetch);
    await expect(mgmt.applications.update('a1', { name: 'n' })).resolves.toEqual({ id: 'a1' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('429 retries are bounded, and the last error carries retryAfter', async () => {
    const limited = apiError(429, 'rate_limited', 'x', undefined, { 'retry-after': '2' });
    const fetch = fakeFetch(limited, limited, limited, limited);
    const { mgmt, sleep } = client(fetch);
    const error = await caught(mgmt.clients.list());
    expect(error).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 2 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('maxRetries is configurable', async () => {
    const limited = apiError(429, 'rate_limited', 'x', undefined, { 'retry-after': '1' });
    const fetch = fakeFetch(limited, limited, limited, limited, limited);
    const { mgmt } = client(fetch, { maxRetries: 4 });
    await caught(mgmt.clients.list());
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  test('maxRetries: false turns retrying off', async () => {
    const fetch = fakeFetch(apiError(429, 'rate_limited', 'x', undefined, { 'retry-after': '1' }));
    const { mgmt, sleep } = client(fetch, { maxRetries: false });
    const error = await caught(mgmt.clients.list());
    expect(error.code).toBe('rate_limited');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('a Retry-After longer than maxRetryWaitMs is thrown, not waited on', async () => {
    const fetch = fakeFetch(apiError(429, 'rate_limited', 'x', undefined, { 'retry-after': '120' }));
    const { mgmt, sleep } = client(fetch);
    const error = await caught(mgmt.clients.list());
    expect(error.retryAfter).toBe(120);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('a Retry-After HTTP date is honoured', async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const fetch = fakeFetch(apiError(429, 'rate_limited', 'x', undefined, { 'retry-after': at }), ok({}));
    const { mgmt, sleep } = client(fetch);
    await mgmt.clients.list();
    const waited = sleep.mock.calls[0][0];
    expect(waited).toBeGreaterThanOrEqual(3000);
    expect(waited).toBeLessThanOrEqual(6000);
  });

  test('a 429 with no Retry-After backs off', async () => {
    const fetch = fakeFetch(apiError(429, 'rate_limited'), ok({}));
    const { mgmt, sleep } = client(fetch);
    await mgmt.clients.list();
    expect(sleep).toHaveBeenCalledWith(500);
  });

  test.each([
    ['GET', (m) => m.clients.get('c1')],
    ['DELETE', (m) => m.credentials.revoke('cr1')],
    ['POST', (m) => m.clients.create({ name: 'Acme' })],
  ])('a 5xx is retried for %s', async (_method, call) => {
    for (const code of ['audit_unavailable', 'intake_unavailable', 'internal_server_error']) {
      const status = code === 'internal_server_error' ? 500 : 503;
      const fetch = fakeFetch(apiError(status, code), ok({ id: 'x' }));
      const { mgmt } = client(fetch);
      await expect(call(mgmt)).resolves.toEqual({ id: 'x' });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  test('a PATCH is never retried after a 5xx', async () => {
    const fetch = fakeFetch(apiError(503, 'audit_unavailable'), ok({}));
    const { mgmt, sleep } = client(fetch);
    const error = await caught(mgmt.environments.update('e1', { name: 'qa' }));
    expect(error.code).toBe('audit_unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('a PATCH is never retried after a network error', async () => {
    const fetch = fakeFetch(new TypeError('fetch failed'), ok({}));
    const { mgmt } = client(fetch);
    const error = await caught(mgmt.clients.packages.update('c1', 'as1', { environment_id: 'e2' }));
    expect(error.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a 4xx other than 429 and in-progress 409 is not retried', async () => {
    for (const [status, code] of [[422, 'delete_refused'], [409, 'intake_credential'], [403, 'insufficient_scope'], [401, 'invalid_key']]) {
      const fetch = fakeFetch(apiError(status, code), ok({}));
      const { mgmt } = client(fetch);
      const error = await caught(mgmt.credentials.revoke('cr1'));
      expect(error.code).toBe(code);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  test('without an injected fetch the global one is used, at call time', async () => {
    const original = global.fetch;
    const fetch = fakeFetch(ok({ id: 'o1' }));
    global.fetch = fetch;
    try {
      const mgmt = new ManagementClient({ apiKey: KEY, baseUrl: BASE });
      await expect(mgmt.organization.get()).resolves.toEqual({ id: 'o1' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = original;
    }
  });

  test('each attempt is bounded by timeoutMs', async () => {
    const fetch = jest.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const mgmt = new ManagementClient({ apiKey: KEY, baseUrl: BASE, fetch, timeoutMs: 5, maxRetries: 0 });
    const error = await caught(mgmt.organization.get());
    expect(error.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(error.message).toMatch(/AbortError/);
  });
});

describe('package entry points', () => {
  test('end-point-blank-js/management resolves to the management client', () => {
    const viaExports = require('end-point-blank-js/management');
    expect(viaExports.ManagementClient).toBe(ManagementClient);
  });

  test('the runtime entry point does not load the management client', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const script =
      "require('./src'); require('./src/express'); require('./src/middleware/report-interaction');" +
      "process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((p) => p.includes('management'))));";
    const loaded = execFileSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(loaded)).toEqual([]);
  });
});
