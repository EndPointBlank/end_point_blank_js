// Type declarations for `end-point-blank-js/management`, the EndPointBlank
// management API client. Field names are the API's own (snake_case), as
// documented at /docs/management-api and in GET /api/v1/openapi.json.

/** A UUID string. */
export type Uuid = string;
/** An ISO 8601 timestamp string. */
export type Timestamp = string;

// --- Client -------------------------------------------------------------------

export interface ManagementClientOptions {
  /** A management API key, `epb_mk_...`. Never a runtime client credential. */
  apiKey: string;
  /** Default `https://app.endpointblank.com`. Without `/api/v1`. Must be https, except for localhost, 127.0.0.1 and [::1]. */
  baseUrl?: string;
  /** Retries after the first attempt (default 2). `0` or `false` turns retrying off. */
  maxRetries?: number | false;
  /** The longest `Retry-After` wait honoured, in ms (default 60000). A longer one is thrown. */
  maxRetryWaitMs?: number;
  /** Backoff for a retry with no `Retry-After`: this, then twice this, ... (default 500 ms). */
  retryBaseDelayMs?: number;
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<unknown>;
}

/** Options every POST takes. */
export interface PostOptions {
  /** Sent as `Idempotency-Key` (1-255 bytes, no control characters). Generated (UUID v4) when omitted. Reused on every retry. */
  idempotencyKey?: string;
}

export interface PageParams {
  /** 1 to 100, default 50. */
  limit?: number;
  /** A `next_cursor` from an earlier page. */
  after?: string | null;
}

export interface Page<T> {
  data: T[];
  /** `null` on the last page. */
  next_cursor: string | null;
}

export interface Deleted {
  id: Uuid;
  deleted: true;
}

export declare const DEFAULT_BASE_URL: 'https://app.endpointblank.com';

export declare class ManagementClient {
  constructor(options: ManagementClientOptions);
  /** The base URL calls go to, without `/api/v1`. */
  readonly baseUrl: string;
  readonly organization: OrganizationResource;
  readonly apiPackages: ApiPackagesResource;
  readonly endpoints: EndpointsResource;
  readonly clients: ClientsResource;
  readonly applications: ApplicationsResource;
  readonly environments: EnvironmentsResource;
  readonly credentials: CredentialsResource;
  /** Calls for one of your managed clients, under `/clients/:client_id/...`. */
  forManagedClient(clientId: Uuid): ManagedClientScope;
  toString(): string;
  toJSON(): { baseUrl: string; apiKey: string };
}

export declare class ManagedClientScope {
  /** Made by `ManagementClient#forManagedClient`, not directly. */
  private constructor();
  readonly clientId: Uuid;
  readonly applications: ApplicationsResource;
  readonly environments: EnvironmentsResource;
  readonly credentials: CredentialsResource;
  claimInvite(body: ClaimInviteRequest, options?: PostOptions): Promise<ClaimInvite>;
}

// --- Errors -------------------------------------------------------------------

export declare const ErrorCode: Readonly<{
  MISSING_KEY: 'missing_key';
  INVALID_KEY: 'invalid_key';
  RUNTIME_CREDENTIAL_REFUSED: 'runtime_credential_refused';
  INSUFFICIENT_SCOPE: 'insufficient_scope';
  AUDIT_UNAVAILABLE: 'audit_unavailable';
  RATE_LIMITED: 'rate_limited';
  PLAN_LIMIT: 'plan_limit';
  VALIDATION_FAILED: 'validation_failed';
  NOT_FOUND: 'not_found';
  INVALID_PAGINATION: 'invalid_pagination';
  INVALID_FILTER: 'invalid_filter';
  INVALID_IDEMPOTENCY_KEY: 'invalid_idempotency_key';
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused';
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'idempotency_request_in_progress';
  IDEMPOTENCY_REPLAY_UNAVAILABLE: 'idempotency_replay_unavailable';
  BAD_REQUEST: 'bad_request';
  INTERNAL_SERVER_ERROR: 'internal_server_error';
  HAS_DEPENDENTS: 'has_dependents';
  PROTECTED: 'protected';
  INVALID_ENVIRONMENT_BASE_URLS: 'invalid_environment_base_urls';
  API_PACKAGE_ASSIGNED: 'api_package_assigned';
  INTAKE_SYNC_FAILED: 'intake_sync_failed';
  DELETE_REFUSED: 'delete_refused';
  INTAKE_CREDENTIAL: 'intake_credential';
  INTAKE_REJECTED: 'intake_rejected';
  INTAKE_UNAVAILABLE: 'intake_unavailable';
  INVALID_CONTACTS: 'invalid_contacts';
  INVALID_PACKAGES: 'invalid_packages';
  INVALID_GRANTS: 'invalid_grants';
  INVALID_MANAGED: 'invalid_managed';
  CLIENT_NOT_ACCEPTED: 'client_not_accepted';
  CLIENT_ACCEPTED: 'client_accepted';
  CLIENT_NOT_MANAGED: 'client_not_managed';
  RETURN_TO_NOT_REGISTERED: 'return_to_not_registered';
  ALREADY_A_MEMBER: 'already_a_member';
  MANAGED_CLIENT_HAS_CREDENTIALS: 'managed_client_has_credentials';
  API_PACKAGE_NOT_FOUND: 'api_package_not_found';
  ENVIRONMENT_NOT_FOUND: 'environment_not_found';
  ALREADY_ASSIGNED: 'already_assigned';
  NOTHING_PUBLISHED_IN_ENVIRONMENT: 'nothing_published_in_environment';
  APPLICATION_NOT_FOUND: 'application_not_found';
  ENDPOINT_NOT_FOUND: 'endpoint_not_found';
  ENVIRONMENT_NOT_IN_APPLICATION: 'environment_not_in_application';
  ALREADY_GRANTED: 'already_granted';
  GRANT_REVOKED_CONCURRENTLY: 'grant_revoked_concurrently';
  NETWORK_ERROR: 'network_error';
  HTTP_ERROR: 'http_error';
  INVALID_RESPONSE: 'invalid_response';
}>;

/** A known code, or any other string the server sends. */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode] | (string & {});

export declare class ManagementApiError extends Error {
  name: 'ManagementApiError';
  /** The API's `error.code`, passed through even when unknown to this SDK. */
  code: ErrorCodeValue;
  /** Field errors (`validation_failed`), `published_in`, and so on; `null` when none. */
  details: Record<string, unknown> | null;
  /** HTTP status, or `null` when no answer arrived (`network_error`). */
  status: number | null;
  /** `Retry-After` in seconds, or `null`. */
  retryAfter: number | null;
  method: string | null;
  /** `/api/v1/...`, without host or query. */
  path: string | null;
  idempotencyKey: string | null;
  /** The answer's `location` header, or `null`. */
  location: string | null;
  /** app_portal's `x-request-id`, or `null`. */
  requestId: string | null;
}

/** Thrown by the constructor for a bad option (the same class `configure()` throws). */
export declare class ConfigurationError extends Error {}

// --- Organization ---------------------------------------------------------------

export interface Organization {
  id: Uuid;
  name: string;
  domain: string | null;
  slug: string | null;
  key: { name: string; scope: 'read' | 'write' };
}

export declare class OrganizationResource {
  get(): Promise<Organization>;
}

// --- API packages ----------------------------------------------------------------

export interface ApiPackage {
  id: Uuid;
  name: string;
  organization_id: Uuid;
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApiPackageRequest {
  name: string;
}

export interface ApiPackageEndpoint {
  id: Uuid;
  api_package_id: Uuid;
  application_id: Uuid;
  endpoint_id: Uuid | null;
  all_endpoints: boolean;
  endpoint: { id: Uuid; path: string; action: string } | null;
  environment_id: Uuid;
  inserted_at: Timestamp;
}

export interface AddApiPackageEndpointRequest {
  application_id: Uuid;
  /** Omit or `null` for every endpoint of the application. */
  endpoint_id?: Uuid | null;
  environment_id: Uuid;
}

export interface ApiPackageWarning {
  code: 'assignment_derives_nothing' | (string & {});
  message: string;
  client_organization_id: Uuid;
  environment_id: Uuid;
}

export interface ApiPackageEndpointAdded {
  data: ApiPackageEndpoint;
  warnings: ApiPackageWarning[];
}

export interface ApiPackageEndpointRemoved {
  data: Deleted;
  warnings: ApiPackageWarning[];
}

export declare class ApiPackageEndpointsResource {
  list(apiPackageId: Uuid, params?: PageParams): Promise<Page<ApiPackageEndpoint>>;
  listAll(apiPackageId: Uuid, params?: PageParams): AsyncGenerator<ApiPackageEndpoint, void, undefined>;
  pages(apiPackageId: Uuid, params?: PageParams): AsyncGenerator<Page<ApiPackageEndpoint>, void, undefined>;
  add(apiPackageId: Uuid, body: AddApiPackageEndpointRequest, options?: PostOptions): Promise<ApiPackageEndpointAdded>;
  remove(apiPackageId: Uuid, accessId: Uuid): Promise<ApiPackageEndpointRemoved>;
}

export declare class ApiPackagesResource {
  readonly endpoints: ApiPackageEndpointsResource;
  list(params?: PageParams): Promise<Page<ApiPackage>>;
  listAll(params?: PageParams): AsyncGenerator<ApiPackage, void, undefined>;
  pages(params?: PageParams): AsyncGenerator<Page<ApiPackage>, void, undefined>;
  create(body: ApiPackageRequest, options?: PostOptions): Promise<ApiPackage>;
  get(id: Uuid): Promise<ApiPackage>;
  update(id: Uuid, body: ApiPackageRequest): Promise<ApiPackage>;
  delete(id: Uuid): Promise<Deleted>;
}

// --- Endpoint lookup -------------------------------------------------------------

export interface Endpoint {
  id: Uuid;
  application_id: Uuid;
  path: string;
  action: string;
  public: boolean | null;
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface EndpointListParams extends PageParams {
  application_id?: Uuid;
  /** An application version name: only endpoints deployed in a version of that name. */
  version?: string;
}

export declare class EndpointsResource {
  list(params?: EndpointListParams): Promise<Page<Endpoint>>;
  listAll(params?: EndpointListParams): AsyncGenerator<Endpoint, void, undefined>;
  pages(params?: EndpointListParams): AsyncGenerator<Page<Endpoint>, void, undefined>;
}

// --- Clients ---------------------------------------------------------------------

export type AssignmentStatus = 'active' | 'pending' | 'refused';

export interface Refusal {
  code: string;
  message: string;
  at: Timestamp;
}

export interface Contact {
  id?: Uuid;
  email: string;
  first_name: string;
  last_name: string;
  title?: string | null;
  phone_number?: string | null;
}

export interface PackageAssignment {
  id: Uuid;
  api_package_id: Uuid;
  api_package_name: string;
  environment_id: Uuid;
  status: AssignmentStatus;
  refusal: Refusal | null;
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface Grant {
  id: Uuid;
  /** `null` for a grant set up for a pending invite. */
  client_organization_id: Uuid | null;
  target_application_id: Uuid;
  target_endpoint_id: Uuid | null;
  all_endpoints: boolean;
  environment_id: Uuid;
  also_granted_by_api_package_ids: Uuid[];
  synced_at: Timestamp | null;
  status: AssignmentStatus;
  refusal: Refusal | null;
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface Client {
  id: Uuid;
  name: string;
  status: 'pending' | 'accepted';
  /** Present for write keys only; set while pending, `null` once accepted. A secret. */
  invite_code?: string | null;
  accepted_at: Timestamp | null;
  managed: boolean;
  claimed_at: Timestamp | null;
  client_organization: { id: Uuid; name: string } | null;
  /** On a single client (`get`, `create`) only. */
  contacts?: Contact[];
  /** On a single client (`get`, `create`) only. */
  pre_assignments?: { packages: PackageAssignment[]; grants: Grant[] };
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface PackageAssignmentRequest {
  api_package_id: Uuid;
  environment_id: Uuid;
}

export interface GrantRequest {
  target_application_id: Uuid;
  /** Omit or `null` for every endpoint of the application. */
  target_endpoint_id?: Uuid | null;
  environment_id: Uuid;
}

export interface CreateClientRequest {
  name: string;
  /** Create the client's organization now and run it for your customer (sc-1481). */
  managed?: boolean;
  contacts?: Array<Omit<Contact, 'id'>>;
  /** Assigned when the client accepts. Not with `managed: true`. */
  packages?: PackageAssignmentRequest[];
  /** Granted when the client accepts. Not with `managed: true`. */
  grants?: GrantRequest[];
}

export interface ClaimInviteRequest {
  email: string;
  /**
   * Where EndPointBlank sends the customer's browser after they claim the client. It must equal,
   * byte for byte, a claim return URL your organization registered in EndPointBlank; otherwise
   * the call answers 422 `return_to_not_registered`. Left out, nothing is sent.
   */
  return_to?: string;
}

export interface ClaimInvite {
  client_id: Uuid;
  email: string;
  sent_at: Timestamp;
  expires_at: Timestamp;
}

export interface GrantRevoked extends Deleted {
  /** True when a package the client holds also derives the grant, so it keeps it. */
  still_granted_by_package: boolean;
}

export declare class ClientPackagesResource {
  list(clientId: Uuid, params?: PageParams): Promise<Page<PackageAssignment>>;
  listAll(clientId: Uuid, params?: PageParams): AsyncGenerator<PackageAssignment, void, undefined>;
  pages(clientId: Uuid, params?: PageParams): AsyncGenerator<Page<PackageAssignment>, void, undefined>;
  assign(clientId: Uuid, body: PackageAssignmentRequest, options?: PostOptions): Promise<PackageAssignment>;
  update(clientId: Uuid, id: Uuid, body: { environment_id: Uuid }): Promise<PackageAssignment>;
  remove(clientId: Uuid, id: Uuid): Promise<Deleted>;
}

export declare class ClientGrantsResource {
  list(clientId: Uuid, params?: PageParams): Promise<Page<Grant>>;
  listAll(clientId: Uuid, params?: PageParams): AsyncGenerator<Grant, void, undefined>;
  pages(clientId: Uuid, params?: PageParams): AsyncGenerator<Page<Grant>, void, undefined>;
  create(clientId: Uuid, body: GrantRequest, options?: PostOptions): Promise<Grant>;
  revoke(clientId: Uuid, id: Uuid): Promise<GrantRevoked>;
}

export declare class ClientsResource {
  readonly packages: ClientPackagesResource;
  readonly grants: ClientGrantsResource;
  list(params?: PageParams): Promise<Page<Client>>;
  listAll(params?: PageParams): AsyncGenerator<Client, void, undefined>;
  pages(params?: PageParams): AsyncGenerator<Page<Client>, void, undefined>;
  create(body: CreateClientRequest, options?: PostOptions): Promise<Client>;
  get(id: Uuid): Promise<Client>;
  delete(id: Uuid): Promise<Deleted>;
  claimInvite(clientId: Uuid, body: ClaimInviteRequest, options?: PostOptions): Promise<ClaimInvite>;
}

// --- Applications, environments ---------------------------------------------------

export interface Application {
  id: Uuid;
  name: string;
  public: boolean | null;
  organization_group_id: Uuid | null;
  synced_at: Timestamp | null;
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface CreateApplicationRequest {
  name: string;
  /** Environment id to base URL; at least one. */
  environment_base_urls: Record<Uuid, string>;
  public?: boolean;
  organization_group_id?: Uuid;
}

export interface UpdateApplicationRequest {
  name?: string;
  public?: boolean;
}

export interface ApplicationEnvironment {
  id: Uuid;
  application_id: Uuid;
  environment_id: Uuid;
  base_url: string;
  synced_at: Timestamp | null;
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface CreateApplicationEnvironmentRequest {
  environment_id: Uuid;
  base_url: string;
}

export interface Environment {
  id: Uuid;
  name: string;
  domain: string;
  is_default: boolean;
  /** The system-managed production environment; it can't be changed. */
  production: boolean;
  synced_at: Timestamp | null;
  inserted_at: Timestamp;
  updated_at: Timestamp;
}

export interface CreateEnvironmentRequest {
  name: string;
  domain: string;
  is_default?: boolean;
}

export type UpdateEnvironmentRequest = Partial<CreateEnvironmentRequest>;

export declare class ApplicationEnvironmentsResource {
  list(applicationId: Uuid, params?: PageParams): Promise<Page<ApplicationEnvironment>>;
  listAll(applicationId: Uuid, params?: PageParams): AsyncGenerator<ApplicationEnvironment, void, undefined>;
  pages(applicationId: Uuid, params?: PageParams): AsyncGenerator<Page<ApplicationEnvironment>, void, undefined>;
  create(
    applicationId: Uuid,
    body: CreateApplicationEnvironmentRequest,
    options?: PostOptions,
  ): Promise<ApplicationEnvironment>;
  delete(applicationId: Uuid, id: Uuid): Promise<Deleted>;
}

export declare class ApplicationsResource {
  readonly environments: ApplicationEnvironmentsResource;
  list(params?: PageParams): Promise<Page<Application>>;
  listAll(params?: PageParams): AsyncGenerator<Application, void, undefined>;
  pages(params?: PageParams): AsyncGenerator<Page<Application>, void, undefined>;
  create(body: CreateApplicationRequest, options?: PostOptions): Promise<Application>;
  get(id: Uuid): Promise<Application>;
  update(id: Uuid, body: UpdateApplicationRequest): Promise<Application>;
  delete(id: Uuid): Promise<Deleted>;
}

export declare class EnvironmentsResource {
  list(params?: PageParams): Promise<Page<Environment>>;
  listAll(params?: PageParams): AsyncGenerator<Environment, void, undefined>;
  pages(params?: PageParams): AsyncGenerator<Page<Environment>, void, undefined>;
  create(body: CreateEnvironmentRequest, options?: PostOptions): Promise<Environment>;
  get(id: Uuid): Promise<Environment>;
  update(id: Uuid, body: UpdateEnvironmentRequest): Promise<Environment>;
  delete(id: Uuid): Promise<Deleted>;
}

// --- Credentials -------------------------------------------------------------------

export interface Credential {
  id: Uuid;
  client_id: string;
  secret_last_4: string;
  application_environment_id: Uuid;
  application_id: Uuid | null;
  environment: { id: Uuid; name: string } | null;
  /** Only while the previous secret still authenticates (after a rotate). */
  previous_secret: { last_4: string; expires_at: Timestamp } | null;
  expired_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** A credential with its secret: answered by `create` and `rotate` only, once. */
export interface CredentialWithSecret extends Credential {
  client_secret: string;
}

export interface CredentialListParams extends PageParams {
  application_environment_id?: Uuid;
}

export declare class CredentialsResource {
  list(params?: CredentialListParams): Promise<Page<Credential>>;
  listAll(params?: CredentialListParams): AsyncGenerator<Credential, void, undefined>;
  pages(params?: CredentialListParams): AsyncGenerator<Page<Credential>, void, undefined>;
  get(id: Uuid): Promise<Credential>;
  create(body: { application_environment_id: Uuid }, options?: PostOptions): Promise<CredentialWithSecret>;
  rotate(id: Uuid, options?: PostOptions): Promise<CredentialWithSecret>;
  revoke(id: Uuid): Promise<Deleted>;
}
