'use strict';

/**
 * The management API's resources, one class per route group under `/api/v1`.
 *
 * Request bodies and answers keep the API's own snake_case field names, so
 * what the docs and `GET /api/v1/openapi.json` say is exactly what is sent and
 * received. Single-resource calls answer the `data` object; list calls answer
 * the page (`{data, next_cursor}`) and have `listAll` (each item) and `pages`
 * (each page) async iterators that follow `next_cursor`.
 *
 * Every POST takes an optional last argument `{idempotencyKey}`; without one a
 * UUID is generated. Either way the same key is sent on every retry.
 */

const MAX_LIMIT = 100;

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * One path segment for an id. An id made only of dots (`.`, `..`, ...) is
 * refused: `fetch` resolves `.` and `..` (and `%2e` forms) as dot-segments, so
 * `clients.grants.revoke('c1', '..')` would otherwise send
 * `DELETE /clients/c1/` and delete the client, and
 * `forManagedClient('..')` would act on the caller's own organization.
 */
const seg = (value) => {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`Expected a non-empty id string, got ${value === '' ? 'an empty string' : typeof value}.`);
  }
  if (/^\.+$/.test(value)) {
    throw new TypeError('An id made only of dots is not an id: it would be sent as a path dot-segment.');
  }
  return encodeURIComponent(value);
};

function checkPageParams(params) {
  if (params === null || typeof params !== 'object') {
    throw new TypeError('List parameters must be an object.');
  }
  const { limit } = params;
  if (limit !== undefined && limit !== null && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return params;
}

class Resource {
  #transport;
  #prefix;

  constructor(transport, prefix = '') {
    this.#transport = transport;
    this.#prefix = prefix;
  }

  _path(path) {
    return this.#prefix + path;
  }

  async _get(path, query) {
    return this.#transport.request('GET', this._path(path), { query });
  }

  async _data(method, path, { body, idempotencyKey } = {}) {
    const answer = await this.#transport.request(method, this._path(path), { body, idempotencyKey });
    return answer.data;
  }

  async _envelope(method, path, { body, idempotencyKey } = {}) {
    return this.#transport.request(method, this._path(path), { body, idempotencyKey });
  }

  async _page(path, params = {}) {
    const answer = await this._get(path, checkPageParams(params));
    return {
      data: Array.isArray(answer.data) ? answer.data : [],
      next_cursor: answer.next_cursor === undefined ? null : answer.next_cursor,
    };
  }

  async *_pages(path, params = {}) {
    checkPageParams(params);
    let after = params.after;
    for (;;) {
      const page = await this._page(path, { ...params, after });
      yield page;
      if (!page.next_cursor) return;
      if (page.next_cursor === after) {
        throw new Error(`The API answered the same next_cursor twice for ${path}; stopping.`);
      }
      after = page.next_cursor;
    }
  }

  async *_all(path, params = {}) {
    for await (const page of this._pages(path, params)) {
      yield* page.data;
    }
  }

  [INSPECT]() {
    return `${this.constructor.name} {}`;
  }
}

// --- Organization ------------------------------------------------------------

class OrganizationResource extends Resource {
  /** `GET /organization`: the organization the key belongs to, and the key's name and scope. */
  get() {
    return this._data('GET', '/organization');
  }
}

// --- API packages ------------------------------------------------------------

class ApiPackageEndpointsResource extends Resource {
  /** `GET /api_packages/:id/endpoints`: one page of what the package publishes. */
  list(apiPackageId, params = {}) {
    return this._page(`/api_packages/${seg(apiPackageId)}/endpoints`, params);
  }

  listAll(apiPackageId, params = {}) {
    return this._all(`/api_packages/${seg(apiPackageId)}/endpoints`, params);
  }

  pages(apiPackageId, params = {}) {
    return this._pages(`/api_packages/${seg(apiPackageId)}/endpoints`, params);
  }

  /**
   * `POST /api_packages/:id/endpoints`: publish an application's endpoint (or
   * every endpoint, with no `endpoint_id`) in one environment.
   *
   * Answers `{data, warnings}`: `warnings` lists client assignments of the
   * package that now derive no grant (`assignment_derives_nothing`).
   */
  add(apiPackageId, body, options = {}) {
    return this._envelope('POST', `/api_packages/${seg(apiPackageId)}/endpoints`, { body, idempotencyKey: options.idempotencyKey });
  }

  /** `DELETE /api_packages/:id/endpoints/:access_id`. Answers `{data, warnings}`. */
  remove(apiPackageId, accessId) {
    return this._envelope('DELETE', `/api_packages/${seg(apiPackageId)}/endpoints/${seg(accessId)}`);
  }
}

class ApiPackagesResource extends Resource {
  constructor(transport) {
    super(transport);
    /** What each package publishes: `/api_packages/:id/endpoints`. */
    this.endpoints = new ApiPackageEndpointsResource(transport);
  }

  list(params = {}) {
    return this._page('/api_packages', params);
  }

  listAll(params = {}) {
    return this._all('/api_packages', params);
  }

  pages(params = {}) {
    return this._pages('/api_packages', params);
  }

  create(body, options = {}) {
    return this._data('POST', '/api_packages', { body, idempotencyKey: options.idempotencyKey });
  }

  get(id) {
    return this._data('GET', `/api_packages/${seg(id)}`);
  }

  update(id, body) {
    return this._data('PATCH', `/api_packages/${seg(id)}`, { body });
  }

  /** Refused with `api_package_assigned` while a client holds the package. */
  delete(id) {
    return this._data('DELETE', `/api_packages/${seg(id)}`);
  }
}

// --- Endpoint lookup ---------------------------------------------------------

class EndpointsResource extends Resource {
  /** `GET /endpoints`, filtered by `application_id` and/or `version`. */
  list(params = {}) {
    return this._page('/endpoints', params);
  }

  listAll(params = {}) {
    return this._all('/endpoints', params);
  }

  pages(params = {}) {
    return this._pages('/endpoints', params);
  }
}

// --- Clients, package assignments, direct grants ---------------------------

class ClientPackagesResource extends Resource {
  list(clientId, params = {}) {
    return this._page(`/clients/${seg(clientId)}/packages`, params);
  }

  listAll(clientId, params = {}) {
    return this._all(`/clients/${seg(clientId)}/packages`, params);
  }

  pages(clientId, params = {}) {
    return this._pages(`/clients/${seg(clientId)}/packages`, params);
  }

  /** `POST /clients/:client_id/packages` with `{api_package_id, environment_id}`. */
  assign(clientId, body, options = {}) {
    return this._data('POST', `/clients/${seg(clientId)}/packages`, { body, idempotencyKey: options.idempotencyKey });
  }

  /** `PATCH /clients/:client_id/packages/:id` with `{environment_id}`. */
  update(clientId, id, body) {
    return this._data('PATCH', `/clients/${seg(clientId)}/packages/${seg(id)}`, { body });
  }

  /** `DELETE /clients/:client_id/packages/:id`: un-assign (or drop a pending one). */
  remove(clientId, id) {
    return this._data('DELETE', `/clients/${seg(clientId)}/packages/${seg(id)}`);
  }
}

class ClientGrantsResource extends Resource {
  list(clientId, params = {}) {
    return this._page(`/clients/${seg(clientId)}/grants`, params);
  }

  listAll(clientId, params = {}) {
    return this._all(`/clients/${seg(clientId)}/grants`, params);
  }

  pages(clientId, params = {}) {
    return this._pages(`/clients/${seg(clientId)}/grants`, params);
  }

  /** `POST /clients/:client_id/grants` with `{target_application_id, target_endpoint_id?, environment_id}`. */
  create(clientId, body, options = {}) {
    return this._data('POST', `/clients/${seg(clientId)}/grants`, { body, idempotencyKey: options.idempotencyKey });
  }

  /** `DELETE /clients/:client_id/grants/:id`. `still_granted_by_package` says whether a package keeps it. */
  revoke(clientId, id) {
    return this._data('DELETE', `/clients/${seg(clientId)}/grants/${seg(id)}`);
  }
}

class ClientsResource extends Resource {
  constructor(transport) {
    super(transport);
    /** API packages a client holds: `/clients/:client_id/packages`. */
    this.packages = new ClientPackagesResource(transport);
    /** Grants a client holds directly: `/clients/:client_id/grants`. */
    this.grants = new ClientGrantsResource(transport);
  }

  list(params = {}) {
    return this._page('/clients', params);
  }

  listAll(params = {}) {
    return this._all('/clients', params);
  }

  pages(params = {}) {
    return this._pages('/clients', params);
  }

  /**
   * `POST /clients`: invite a client (`name`, optional `contacts`, and
   * `packages`/`grants` to apply when it accepts), or with `managed: true`
   * create a managed client run by you until your customer claims it.
   * `owner_email` (with `managed: true`, optional) names the person at your
   * customer who will own it; change it later with `update`.
   */
  create(body, options = {}) {
    return this._data('POST', '/clients', { body, idempotencyKey: options.idempotencyKey });
  }

  get(id) {
    return this._data('GET', `/clients/${seg(id)}`);
  }

  /** `PATCH /clients/:id` with `{owner_email}`: the person at your customer who will own a managed client. */
  update(id, body) {
    return this._data('PATCH', `/clients/${seg(id)}`, { body });
  }

  delete(id) {
    return this._data('DELETE', `/clients/${seg(id)}`);
  }

  /**
   * `POST /clients/:client_id/claim_invites` with `{email}`, and optionally `return_to` (a
   * registered claim return URL, else 422 `return_to_not_registered`): invite your customer to
   * claim a managed client.
   */
  claimInvite(clientId, body, options = {}) {
    return this._data('POST', `/clients/${seg(clientId)}/claim_invites`, { body, idempotencyKey: options.idempotencyKey });
  }

  /**
   * `POST /clients/:client_id/portal_sessions`, with `{return_url}` only when one is given: a
   * single-use link that signs the owner of an unclaimed managed client in to its EndPointBlank
   * portal. Answers `{client_id, url, expires_at, return_url}`.
   *
   * The link expires 60 seconds after it is minted and works once, so mint it when the user
   * clicks and redirect their browser to it; never render it into a page, log it or email it.
   * `return_url` must equal, byte for byte, one of your organization's claim return URLs (else
   * 422 `return_url_not_registered`). The answer is never replayed, so each call sends a new
   * Idempotency-Key unless you pass one, and a reused key answers 409
   * `idempotency_replay_unavailable`: never reuse one across clicks.
   */
  createPortalSession(clientId, { return_url } = {}, options = {}) {
    const body = return_url === undefined || return_url === null ? undefined : { return_url };
    return this._data('POST', `/clients/${seg(clientId)}/portal_sessions`, { body, idempotencyKey: options.idempotencyKey });
  }
}

// --- Applications, environments, credentials (own or a managed client's) ---

class ApplicationEnvironmentsResource extends Resource {
  list(applicationId, params = {}) {
    return this._page(`/applications/${seg(applicationId)}/environments`, params);
  }

  listAll(applicationId, params = {}) {
    return this._all(`/applications/${seg(applicationId)}/environments`, params);
  }

  pages(applicationId, params = {}) {
    return this._pages(`/applications/${seg(applicationId)}/environments`, params);
  }

  /** `POST /applications/:application_id/environments` with `{environment_id, base_url}`. */
  create(applicationId, body, options = {}) {
    return this._data('POST', `/applications/${seg(applicationId)}/environments`, { body, idempotencyKey: options.idempotencyKey });
  }

  delete(applicationId, id) {
    return this._data('DELETE', `/applications/${seg(applicationId)}/environments/${seg(id)}`);
  }
}

class ApplicationsResource extends Resource {
  constructor(transport, prefix = '') {
    super(transport, prefix);
    /** The environments each application runs in: `/applications/:application_id/environments`. */
    this.environments = new ApplicationEnvironmentsResource(transport, prefix);
  }

  list(params = {}) {
    return this._page('/applications', params);
  }

  listAll(params = {}) {
    return this._all('/applications', params);
  }

  pages(params = {}) {
    return this._pages('/applications', params);
  }

  /** `POST /applications` with `{name, environment_base_urls, public?, organization_group_id?}`. */
  create(body, options = {}) {
    return this._data('POST', '/applications', { body, idempotencyKey: options.idempotencyKey });
  }

  get(id) {
    return this._data('GET', `/applications/${seg(id)}`);
  }

  /** `PATCH /applications/:id` with `{name?, public?}`. */
  update(id, body) {
    return this._data('PATCH', `/applications/${seg(id)}`, { body });
  }

  /** Refused with `has_dependents` while grants or credentials depend on it. */
  delete(id) {
    return this._data('DELETE', `/applications/${seg(id)}`);
  }
}

class EnvironmentsResource extends Resource {
  list(params = {}) {
    return this._page('/environments', params);
  }

  listAll(params = {}) {
    return this._all('/environments', params);
  }

  pages(params = {}) {
    return this._pages('/environments', params);
  }

  /** `POST /environments` with `{name, domain, is_default?}`. */
  create(body, options = {}) {
    return this._data('POST', '/environments', { body, idempotencyKey: options.idempotencyKey });
  }

  get(id) {
    return this._data('GET', `/environments/${seg(id)}`);
  }

  update(id, body) {
    return this._data('PATCH', `/environments/${seg(id)}`, { body });
  }

  delete(id) {
    return this._data('DELETE', `/environments/${seg(id)}`);
  }
}

class CredentialsResource extends Resource {
  /** `GET /credentials`, optionally `{application_environment_id}`. Metadata only, never a secret. */
  list(params = {}) {
    return this._page('/credentials', params);
  }

  listAll(params = {}) {
    return this._all('/credentials', params);
  }

  pages(params = {}) {
    return this._pages('/credentials', params);
  }

  get(id) {
    return this._data('GET', `/credentials/${seg(id)}`);
  }

  /**
   * `POST /credentials` with `{application_environment_id}`. The answer's
   * `client_secret` is shown this once: store it before doing anything else.
   */
  create(body, options = {}) {
    return this._data('POST', '/credentials', { body, idempotencyKey: options.idempotencyKey });
  }

  /**
   * `POST /credentials/:id/rotate`: a new `client_secret`, shown this once;
   * the previous secret keeps working for the grace window.
   */
  rotate(id, options = {}) {
    return this._data('POST', `/credentials/${seg(id)}/rotate`, { idempotencyKey: options.idempotencyKey });
  }

  /** `DELETE /credentials/:id`: revoke it on intake, then delete it. */
  revoke(id) {
    return this._data('DELETE', `/credentials/${seg(id)}`);
  }
}

/**
 * Your managed client's own applications, environments and credentials,
 * under `/clients/:client_id/...`. Usable only while the client is your
 * managed client and unclaimed; otherwise every call answers 404 `not_found`.
 */
class ManagedClientScope {
  constructor(transport, clientId) {
    const prefix = `/clients/${seg(clientId)}`;
    this.clientId = clientId;
    this.applications = new ApplicationsResource(transport, prefix);
    this.environments = new EnvironmentsResource(transport, prefix);
    this.credentials = new CredentialsResource(transport, prefix);
    Object.defineProperty(this, '_clients', { value: new ClientsResource(transport), enumerable: false });
  }

  /** `POST /clients/:client_id/claim_invites` for this client. */
  claimInvite(body, options = {}) {
    return this._clients.claimInvite(this.clientId, body, options);
  }

  /** `POST /clients/:client_id/portal_sessions` for this client: see `ClientsResource#createPortalSession`. */
  createPortalSession(body = {}, options = {}) {
    return this._clients.createPortalSession(this.clientId, body, options);
  }
}

module.exports = {
  OrganizationResource,
  ApiPackagesResource,
  ApiPackageEndpointsResource,
  EndpointsResource,
  ClientsResource,
  ClientPackagesResource,
  ClientGrantsResource,
  ApplicationsResource,
  ApplicationEnvironmentsResource,
  EnvironmentsResource,
  CredentialsResource,
  ManagedClientScope,
  MAX_LIMIT,
};
