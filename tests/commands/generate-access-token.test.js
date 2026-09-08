'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { GenerateAccessToken, TokenOutcome } = require('../../src/commands/generate-access-token');

describe('GenerateAccessToken.token', () => {
  const okResponse = body => ({ status: 201, ok: true, json: async () => body });
  const BASE_URL = 'https://api.example.test/orders';

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.baseUrl = 'https://epb.test';
    post.mockReset();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  test('asks the access token endpoint for the given base URL', async () => {
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token(BASE_URL);

    const [url, , body] = post.mock.calls[0];
    expect(url).toBe('https://epb.test/api/access_token');
    expect(body).toEqual({ base_url: BASE_URL });
  });

  test('presents the configured client credentials', async () => {
    // A token request is the one call that cannot itself use a token, so it
    // must go out as Basic or the SDK can never bootstrap.
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token(BASE_URL);

    const authHeader = post.mock.calls[0][1];
    expect(Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString()).toBe(
      'client-id:client-secret',
    );
  });

  test('asks for the configured token lifetime when one is set', async () => {
    config.tokenTtl = 900;
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token(BASE_URL);

    expect(post.mock.calls[0][2]).toEqual({ base_url: BASE_URL, token_ttl: 900 });
  });

  test('omits the lifetime entirely when none is configured, letting the service decide', async () => {
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token(BASE_URL);

    expect(post.mock.calls[0][2]).not.toHaveProperty('token_ttl');
  });

  test('asks for a zero lifetime when that is what was configured', async () => {
    // `0` is falsy but meaningful; a truthiness check here would silently drop it.
    config.tokenTtl = 0;
    post.mockResolvedValue(okResponse({ token: 'tok-1' }));

    await GenerateAccessToken.token(BASE_URL);

    expect(post.mock.calls[0][2].token_ttl).toBe(0);
  });

  test('returns the payload the service sent back', async () => {
    post.mockResolvedValue(
      okResponse({ token: 'tok-1', expired_at: '2026-01-01T00:00:00Z', base_url: BASE_URL }),
    );

    await expect(GenerateAccessToken.token(BASE_URL)).resolves.toEqual({
      token: 'tok-1',
      expired_at: '2026-01-01T00:00:00Z',
      base_url: BASE_URL,
    });
  });

  test('answers null for a non-2xx, rather than handing back its error body', async () => {
    // 422 here is not intake's answer to a bad credential -- that is a 401,
    // covered in the tokenResult block below. This stubs the SDK's own
    // transport with an arbitrary non-success status.
    //
    // `token()` answers null because no token was minted. Returning the error
    // document would hand the caller a truthy value for a request that
    // produced nothing -- the exact failure `tokenResult()` exists to remove,
    // reintroduced one layer down. A caller that wants the body of a refusal
    // asks `tokenResult()`, which carries the outcome and the payload.
    post.mockResolvedValue({ status: 422, ok: false, json: async () => ({ error: 'no such app' }) });

    await expect(GenerateAccessToken.token(BASE_URL)).resolves.toBeNull();
  });

  test('answers null for a 401 as well, and leaves the reason to tokenResult', async () => {
    // A rejected credential is the one failure a caller most needs to act on,
    // and `token()` is the accessor that cannot express it. Handing back
    // `{error: ...}` here reads as a result; null reads as what it is. The
    // outcome is not lost -- `tokenResult()` reports CREDENTIAL_REJECTED with
    // this same body attached.
    post.mockResolvedValue({
      status: 401,
      ok: false,
      json: async () => ({ error: 'invalid credentials' }),
    });

    await expect(GenerateAccessToken.token(BASE_URL)).resolves.toBeNull();
  });

  test('returns null when the service is unreachable', async () => {
    post.mockResolvedValue(null);

    await expect(GenerateAccessToken.token(BASE_URL)).resolves.toBeNull();
  });

  test('answers null for a 2xx that minted nothing, however encouraging the status', async () => {
    // A 201 carrying a token but no base_url is the shape this whole change
    // exists for: it looks like a mint and is not one. There is nowhere to
    // cache the token and nothing usable to return, so `token()` says so.
    // The body is still reachable through `tokenResult().payload`.
    post.mockResolvedValue({ status: 201, ok: true, json: async () => ({ token: 'tok-1' }) });

    await expect(GenerateAccessToken.token(BASE_URL)).resolves.toBeNull();
  });

  test('returns null rather than throwing when the response is not JSON', async () => {
    // An HTML error page from a proxy must not take the caller's request down
    // with it — this runs inside the customer's request path.
    post.mockResolvedValue({
      status: 502,
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(GenerateAccessToken.token(BASE_URL)).resolves.toBeNull();
  });
});

describe('GenerateAccessToken.tokenResult', () => {
  // The status intake answers with carries a decision the caller has to make:
  // a 401 will keep being a 401 until the credential is re-issued, a 400/422
  // until the request or the registration changes, while a 5xx or a dropped
  // connection is worth trying again. `token()` flattens all of that to a
  // payload-or-null; `tokenResult()` is the entry point that keeps it.
  const BASE_URL = 'https://api.example.test/orders';
  const response = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  beforeEach(() => {
    config._reset();
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.baseUrl = 'https://epb.test';
    post.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  test('names its outcomes as a frozen constant, so callers branch on a symbol', () => {
    expect(Object.isFrozen(TokenOutcome)).toBe(true);
    expect(TokenOutcome).toEqual({
      SUCCESS: 'success',
      CREDENTIAL_REJECTED: 'credential_rejected',
      REQUEST_REJECTED: 'request_rejected',
      SERVER_ERROR: 'server_error',
      TRANSPORT_ERROR: 'transport_error',
    });
  });

  test('reports a minted token as a success carrying the payload', async () => {
    const payload = { token: 'tok-1', expired_at: '2026-01-01T00:00:00Z', base_url: BASE_URL };
    post.mockResolvedValue(response(201, payload));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.SUCCESS,
      status: 201,
      payload,
    });
  });

  test('reports a 401 as a rejected credential, which no retry can fix', async () => {
    // intake answers 401 -- deliberately not 422 -- when the client
    // credential is invalid or revoked. Nothing but re-issuing it helps.
    post.mockResolvedValue(response(401, { error: 'invalid credentials' }));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.CREDENTIAL_REJECTED,
      status: 401,
      payload: { error: 'invalid credentials' },
    });
  });

  test.each([
    ['a malformed request', 400, { error: 'Missing required parameter: base_url' }],
    ['an unregistered target', 422, { error: 'Missing target application' }],
    ['a client error with no body of its own', 404, {}],
  ])('reports %s as a rejected request, not as a transient server fault', async (_label, status, body) => {
    // Permanent like a 401, but the remedy is the request or the
    // registration rather than the credential -- so it cannot share the
    // outcome a caller reads as "retry is reasonable".
    post.mockResolvedValue(response(status, body));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.REQUEST_REJECTED,
      status,
      payload: body,
    });
  });

  test.each([[500], [502], [503]])('reports HTTP %i as a server error worth retrying', async (status) => {
    post.mockResolvedValue(response(status, { error: 'boom' }));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.SERVER_ERROR,
      status,
      payload: { error: 'boom' },
    });
  });

  test('reports an unreachable service as a transport error with no status', async () => {
    // `post()` has already exhausted its own retries by the time it answers
    // null, so there is no status to report -- the request never landed.
    // TRANSPORT_ERROR means exactly that: no usable HTTP status was obtained.
    post.mockResolvedValue(null);

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.TRANSPORT_ERROR,
      status: null,
      payload: null,
    });
  });

  const unreadable = status => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  });

  test('reports a 401 with an unreadable body as a rejected credential, not as transient', async () => {
    // The SDK reaches intake through Caddy, and anything in front of the app
    // -- a reverse proxy, a WAF, an ALB, an auth gateway -- can answer 401
    // with an HTML error page intake never generated. The credential really
    // is being refused; calling that transient would have the caller retry a
    // request that can never succeed, forever. The status decides.
    post.mockResolvedValue(unreadable(401));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.CREDENTIAL_REJECTED,
      status: 401,
      payload: null,
    });
  });

  test.each([
    ['a rejected request', 422, TokenOutcome.REQUEST_REJECTED],
    ['a failing service', 502, TokenOutcome.SERVER_ERROR],
  ])('classifies %s with an unreadable body by its status too', async (_label, status, outcome) => {
    post.mockResolvedValue(unreadable(status));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome,
      status,
      payload: null,
    });
  });

  test.each([
    ['no token at all', {}],
    ['an error where a token should be', { error: 'unknown application' }],
    ['a token but no base_url', { token: 'tok-1' }],
    ['an empty token', { token: '', base_url: BASE_URL }],
    ['an empty base_url', { token: 'tok-1', base_url: '' }],
  ])('reports a 2xx carrying %s as a broken server, not as a success', async (_label, body) => {
    // SUCCESS has to mean a usable mint, or `outcome === SUCCESS` is not
    // safe to branch on and every caller has to re-check the payload by
    // hand -- an omitted re-check being exactly the silent failure this
    // whole change removes. intake's base_url is NOT NULL and it answers 422
    // rather than minting when the URL resolves to nothing, so a 2xx without
    // one is a broken server, and it is reported with its real 2xx status.
    post.mockResolvedValue(response(201, body));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.SERVER_ERROR,
      status: 201,
      payload: body,
    });
  });

  test('reports a 2xx it cannot read as a broken server', async () => {
    // The one case where a parse failure decides the outcome: the status said
    // yes and there is nothing to act on, which is the same broken server as
    // a 201 carrying no token.
    post.mockResolvedValue(unreadable(201));

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.SERVER_ERROR,
      status: 201,
      payload: null,
    });
  });

  test('refuses to classify a response that carries no status at all', async () => {
    // Not reachable through `fetch`, but the classification must not fall
    // through to a bucket by accident if it ever is -- an unclassifiable
    // answer is a failed exchange, and it says so.
    post.mockResolvedValue({ json: async () => ({ token: 'tok-1' }) });

    await expect(GenerateAccessToken.tokenResult(BASE_URL)).resolves.toEqual({
      outcome: TokenOutcome.TRANSPORT_ERROR,
      status: null,
      payload: null,
    });
  });

  test('returns a frozen result, so a caller cannot rewrite the outcome it was handed', async () => {
    post.mockResolvedValue(response(401, { error: 'invalid credentials' }));

    const result = await GenerateAccessToken.tokenResult(BASE_URL);

    expect(Object.isFrozen(result)).toBe(true);
  });

  test('the outcome names are re-exported from the public entry point', () => {
    // Same object, not a copy: a consumer that reaches the constant through
    // `require('end-point-blank-js')` must be branching on the very values
    // this module produces, the way `LogMode` is already surfaced there.
    const epb = require('../../src/index');

    expect(epb.TokenOutcome).toBe(TokenOutcome);
  });

  test('token() is a thin wrapper over it and returns only the payload', async () => {
    const payload = { token: 'tok-1', base_url: BASE_URL };
    post.mockResolvedValue(response(201, payload));

    await expect(GenerateAccessToken.token(BASE_URL)).resolves.toEqual(payload);
  });
});
