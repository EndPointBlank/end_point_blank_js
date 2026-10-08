# EndPointBlank (JavaScript)

Node.js and Express SDK for [EndPointBlank](https://endpointblank.com): authorize
service-to-service API calls, report endpoint versions, and see which clients still call deprecated
API versions. It covers endpoint tracking, request/response/error/log reporting, route
authorization &amp; authentication, and client-side data masking — with an optional Express
integration.

## Installation

This package is **not yet published to npm**. Until it is, install it directly from GitHub:

```sh
npm install github:EndPointBlank/end_point_blank_js
# or a pinned ref:
npm install github:EndPointBlank/end_point_blank_js#v0.6.0
```

Once published, the intended install command will be:

```sh
npm install end-point-blank-js
```

Requires Node.js >= 18 (the library uses the native `fetch` API and `async_hooks`). Express is an
optional peer dependency — only needed if you use the Express middleware/integration described
below.

## Quick start

```js
const epb = require('end-point-blank-js');

epb.configure({
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  appName: 'my-app',
  environment: 'production',
});

// Express: report every request/response, and unhandled errors
const { reportInteraction, reportInteractionErrorHandler } =
  require('end-point-blank-js/middleware');

app.use(reportInteraction);
app.use(yourRoutes);
app.use(reportInteractionErrorHandler); // must be registered after your routes
```

> **Note on requiring submodules:** the package's `main` entry (`src/index.js`) exports the
> top-level `configure`/`VERSION`/`LogMode`/`TokenOutcome`/`UnauthorizedError`/`config` API. The Express
> integration is available as a whole via `require('end-point-blank-js/express')`, the
> reporting middleware via `require('end-point-blank-js/middleware')` and the management API
> client via `require('end-point-blank-js/management')` (see the `exports` map in
> `package.json`). Everything else (individual writers, commands, etc.) can still be required by
> its real path under `src/`, e.g. `require('end-point-blank-js/src/writers/log-writer')`.

## Configuration

Call `configure({...})` once, typically at application boot. Every option is optional — only the
keys you pass are updated, and calling `configure` again merges into the existing configuration
(it does not reset unspecified keys).

A key that is not in the table below makes `configure` throw a `ConfigurationError` naming the
unknown key(s) and listing the valid ones, and nothing from that call is applied. This includes an
unknown key whose value is `undefined`. A typo such as `clientSecert` fails at boot instead of
leaving the app running without credentials.

Several settings fall back to an `ENDPOINTBLANK_*` environment variable when not explicitly
configured, then to a built-in default. **Precedence: explicit `configure()` value > environment
variable > default.**

| `configure()` key | Env var fallback | Default | Notes |
|---|---|---|---|
| `clientId` | `ENDPOINTBLANK_CLIENT_ID` | `null` | Used for Basic auth and access-token requests. |
| `clientSecret` | `ENDPOINTBLANK_CLIENT_SECRET` | `null` | Paired with `clientId`. |
| `baseUrl` | `ENDPOINTBLANK_BASE_URL` | `https://in.endpointblank.com` | Base for endpoint updates, access tokens, and authorize/authenticate calls. |
| `logBaseUrl` | `ENDPOINTBLANK_LOG_BASE_URL` | `https://log.endpointblank.com` | Base for request/response/log/error reporting. |
| `appName` | `ENDPOINTBLANK_APP_NAME` | `null` | Sent as `application`/`app_name` on every payload. |
| `environment` | `ENDPOINTBLANK_ENV` | `null` | Sent as `env` on every payload. See note below on error-report resolution. |
| `applicationVersion` | — | `null` | Sent as `app_version` when registering endpoints. |
| `versionFinder` | — | `null` | `(req) => string \| null`, overrides automatic endpoint-version detection. |
| `logMode` | — | `LogMode.DIRECT` | `LogMode.DIRECT` (synchronous POST) or `LogMode.DELAYED` (queued, flushed in the background, batches of 4, bounded at 1000 queued items). |
| `tokenTtl` | — | `null` | Seconds; sent as `token_ttl` when requesting an access token, if set. |
| `cacheTtl` | — | `300` | Seconds, a non-negative integer; TTL for the authentication-cache entries used by the `authorized` Express guard (`authenticated` never reads or writes this cache). Omit it for the default; `0` disables the cache; `null`, a negative number or a non-integer throws — see [`cacheTtl` values](#cachettl-values). Re-read on every cache lookup (see note below); while it is `0`, the next lookup or write made in *this process* clears that process's whole cache, not only itself — see the per-process note below. |
| `trustProxyHeaders` | — | `true` | Whether the per-request `scheme`/`host`/`port` report honors `X-Forwarded-Proto`/`-Host`/`-Port`. See [Reported base URL](#reported-base-url). |
| `workerCount` | — | `4` | Number of concurrent in-flight batch requests `LogMode.DELAYED` uses when draining its background queue (Node is single-threaded, so this is concurrent `setImmediate`/async work rather than OS threads — the closest analog to the Ruby gem's threaded writer pool). |
| `maskingRules` | — | `[]` | See [Data masking](#data-masking). |
| `maskHook` | — | `null` | See [Data masking](#data-masking). |
| `deriveBaseUrlFromClientId` | — | `false` | Derive the intake hostname from a slug-prefixed `clientId` when no base URL is set; must be a boolean, anything else throws `ConfigurationError`. See [Intake hostname from `clientId`](#intake-hostname-from-clientid). |

Note: `environment` resolution differs slightly depending on where it's read from. `config.environment`
itself resolves `explicit > ENDPOINTBLANK_ENV > null`. `SessionConfiguration.envName()` goes one step
further — `explicit > ENDPOINTBLANK_ENV > NODE_ENV > 'production'` — and is exported for callers that
want that chain. Error-report payloads no longer carry an `env` of their own: intake's error ingest has
no column for one, and derives a call's environment from the credential it presents.

There is no env-var fallback for `applicationVersion`, `versionFinder`, `logMode`, `tokenTtl`,
`cacheTtl`, `trustProxyHeaders`, `workerCount`, `maskingRules`, `maskHook`, or
`deriveBaseUrlFromClientId` — those must be set via `configure()`.

### `cacheTtl` values

`cacheTtl` follows the `cache_ttl` rule decided for all five EndPointBlank SDKs (JS, Java,
Elixir, Python, Rails) in sc-970:

| Value | Result |
|---|---|
| omitted (or `undefined`) | left as it is: the default of 300 seconds, unless an earlier `configure()` call set it |
| `0` | the authentication cache is disabled |
| a positive integer | that many seconds |
| `null` | throws `ConfigurationError` — omit the key instead to get the default |
| a negative number | throws `ConfigurationError` — use `0` to disable the cache |
| anything that is not an integer — a float such as `3.5`, a string (even `'300'`), `NaN`, `Infinity`, a boolean | throws `ConfigurationError` |

The error comes from `configure()` itself, before anything from that call is applied, not from
the first cache lookup. Assigning `epb.config.cacheTtl` directly is checked the same way, except
that `undefined` is refused there as well: it means "omitted" only as a `configure()` key. A
refused value leaves the previous one in place. A value read from an environment variable is a
string, so convert it to a number before passing it.

### Reported base URL

Every request payload carries the base URL the *caller* used, as three separate fields —
`scheme`, `host` and `port`. A field that cannot be resolved is omitted rather than sent as
null. EndPointBlank uses these to fill in an application environment's base URL for you,
instead of asking someone to type it.

By default the library honors `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Port`,
reading the **last** comma-separated hop. It reads them itself and does **not** consult
Express's `trust proxy` setting, so that all five EndPointBlank clients answer identically for
the same request. (Express's own `req.hostname` takes the *first* forwarded hop; this
deliberately differs.)

**Turn this off if your application is reachable directly, with no proxy in front of it** —
or if you would simply rather report nothing than report something a caller could influence:

```js
epb.configure({ trustProxyHeaders: false });
```

With it off, the `X-Forwarded-*` headers are ignored entirely and `scheme`, `host` and `port`
come from the connection and the `Host` header only.

It defaults to `true` because the alternative is worse for almost everyone. Most production
deployments sit behind an ALB, nginx, Caddy or an Ingress, and a client that ignored the
forwarded headers there would not report *nothing* — it would confidently report an internal
hostname on an internal port. `host` is caller-controlled either way (it has always come from
the `Host` header), and none of these three values is ever used as an identity or
authorization key, so the worst case is a wrong *suggestion* that an admin has to approve.

### Intake hostname from `clientId`

Each organization's intake will answer at its own hostname,
`https://<slug>.in.endpointblank.com`, and every new `clientId` starts with that slug and a dot
(`acima-x7k2mq.ijXI+MVwmrC5xH/9ZuGiQlAbAyobTqMa`). With `deriveBaseUrlFromClientId: true`, the
SDK picks its intake in this order:

1. `baseUrl`, or else `ENDPOINTBLANK_BASE_URL`, if either is set;
2. else, if the `clientId` carries a slug prefix, `https://<slug>.in.endpointblank.com`;
3. else `https://in.endpointblank.com`.

A `clientId` carries a slug prefix only when the part before its first `.` has the exact shape
of an organization slug and something follows the dot (`clientIdSlug` in `src/configuration`).
A credential issued before slugs, including one with a `.` in it such as `my.client`, keeps
calling `https://in.endpointblank.com`.

**This is off by default, and turns on by default in a later release, once DNS and TLS for
`*.in.endpointblank.com` are live.** Until then those hostnames do not resolve in production, so
leave it off unless EndPointBlank has told you otherwise. With it off, the base URL is `baseUrl`,
else `ENDPOINTBLANK_BASE_URL`, else `https://in.endpointblank.com`, whatever the `clientId`.

The logs hostname is not derived: `logBaseUrl`, else `ENDPOINTBLANK_LOG_BASE_URL`, else
`https://log.endpointblank.com`, as before.

Every call to intake also sends `x-epb-sdk: js/<version>`, so EndPointBlank can tell which SDK
versions use a credential before it moves an organization to another intake. The minimum JS
version for a move is the release that turns `deriveBaseUrlFromClientId` on by default, **not**
this one: with the option at its default here, the SDK keeps calling
`https://in.endpointblank.com` after its organization has moved.

**Explicit configuration:**

```js
const epb = require('end-point-blank-js');
const { LogMode } = epb;

epb.configure({
  clientId: 'abc123',
  clientSecret: 'shh',
  baseUrl: 'https://in.endpointblank.com',
  logBaseUrl: 'https://log.endpointblank.com',
  appName: 'checkout-service',
  environment: 'production',
  applicationVersion: '3.4.1',
  logMode: LogMode.DELAYED,
  cacheTtl: 300,
});
```

**12-factor / environment-variable style** (leave the corresponding `configure()` keys unset):

```sh
export ENDPOINTBLANK_CLIENT_ID=abc123
export ENDPOINTBLANK_CLIENT_SECRET=shh
export ENDPOINTBLANK_BASE_URL=https://in.endpointblank.com
export ENDPOINTBLANK_LOG_BASE_URL=https://log.endpointblank.com
export ENDPOINTBLANK_APP_NAME=checkout-service
export ENDPOINTBLANK_ENV=production
```

```js
// No configure() call needed for the values above — they're picked up from
// process.env automatically. Still call configure() for options that have no
// env-var equivalent (maskingRules, logMode, applicationVersion, etc.).
const epb = require('end-point-blank-js');
epb.configure({ applicationVersion: '3.4.1' });
```

## Usage

### Authorization &amp; authentication (Express route guards)

Two independent route-level guards call out to the EndPointBlank API and pass an
`UnauthorizedError` to `next(err)` on failure (non-201 response):

```js
const { authenticated, authorized } = require('end-point-blank-js/express');

// authenticated: verifies the caller's credentials
router.get('/protected', authenticated, (req, res) => res.json({ ok: true }));

// authorized: verifies the caller is allowed to hit this specific endpoint
router.get('/sensitive', authorized, (req, res) => res.json({ ok: true }));

// Either can be applied router-wide too:
router.use(authenticated);
```

Successful `authorized` checks are cached in-process (keyed on credentials + path + method +
`appName`) for `cacheTtl` seconds, so repeat calls to the same endpoint skip the network round
trip. Authorization and authentication requests to EndPointBlank use HTTP Basic auth built from
`clientId`/`clientSecret` (built internally by `Authorization.intakeHeader()`) — EndPointBlank
already holds this service's credential, so minting a token to present it back would buy nothing.
That Basic header only ever goes to EndPointBlank intake; it is never sent to a provider (see below).

`cacheTtl` is consulted fresh on every cache read, not only when an entry is written, so a
`configure({ cacheTtl: ... })` call made while the process is running takes effect immediately
for entries already cached:

- **Lowering it** shortens the remaining life of existing entries to the new window, measured
  from when each was written — useful for making a revoked grant stop answering from cache
  sooner during an incident, without waiting out the original TTL.
- **Raising it** never extends an entry past the expiry it was written with; only entries
  written after the change get the longer TTL.
- **Setting it to `0` disables the cache.** (A negative value is refused — see
  [`cacheTtl` values](#cachettl-values).) The *next* thing that actually touches the
  cache while it is disabled clears the **entire** cache — every entry, not only the one that
  call happened to look up or write — and inserts nothing if it was a store. That "next thing"
  is specifically: **an `authorized` request** (it is the only one of the two Express guards
  that reads or writes this cache at all — **`authenticated` never touches it**, so
  `authenticated`-only or unguarded traffic can never trigger this clear, disabled or not), or
  a direct `retrieve`/`exists`/`store` call against the underlying `AuthenticationCache`
  instance (internal; this is how this package's own tests exercise it). This matches the
  Elixir SDK's `AuthCache` (`get`/`put` while disabled wipe its whole table the same way).

  **This clear only happens on an `authorized` request (never an `authenticated` one) or a
  direct cache call made while disabled — it is not triggered by `configure()` itself.**
  `configure({ cacheTtl: 0 })` immediately followed by `configure({ cacheTtl: 300 })`, with no
  `authorized` request or direct cache call in between, flushes **nothing**: nothing ever ran
  while disabled to trigger the clear, so every entry — including a revoked grant an operator
  meant to force out — keeps answering until its original expiry, up to the TTL it was cached
  under. Elixir has this same residual for the same reason. If you are disabling the cache
  specifically to force a flush, make sure at least one `authorized` request (or a direct
  `retrieve`/`store` call) actually happens before you re-enable it — disabling and re-enabling
  back-to-back, with no `authorized` traffic in between, do not touch the cache at all, and
  `authenticated`-only or unguarded traffic in that window never will either.

  **All of this is per-process — `cacheTtl`, "currently disabled", and the cache itself are all
  plain in-memory state private to one Node process, never shared or coordinated across
  processes.** In any deployment with more than one process serving traffic — a PM2 or Node
  `cluster` with multiple workers, several container/app instances behind a load balancer, and
  so on — each process has its own independent copy of all three. A `configure()` call changes
  only the process that executes it; the disabled-and-clear behavior above only ever affects the
  cache of whichever process happens to handle the `authorized` request or direct cache call.

  Concretely: "disable, let a request through, re-enable" flushes only the process(es) that
  actually go through all three steps *themselves* — it does not flush a fleet as a unit, and
  nothing here coordinates that across processes. For a given worker's cache to clear, that
  worker must (1) have `cacheTtl` set to `0` in its own memory, (2) itself handle an
  `authorized` request (or a direct cache call) while it is in that state, and (3) only then have
  `cacheTtl` set back to a positive value. If `configure({ cacheTtl: 0 })` only reaches one
  worker (an admin action routed to a single process, for example), or a worker gets no
  `authorized` traffic before it is re-enabled, that worker's cache is left untouched and a
  revoked grant keeps answering from it for up to its original TTL — on that worker only,
  independent of what any other worker's cache is doing. There is nothing in this SDK that
  disables, drains traffic to, and re-enables every process in a fleet together; confirming a
  fleet-wide flush actually happened, process by process, is on the operator. Restarting every
  process is one direct way to start each one with an empty cache, since the cache lives only in
  that process's memory and nowhere else.

Both guards post to the same endpoint and describe the call with the same keys — `client_auth`,
`path`, `http_method`, `endpoint_version` and `source_ip`. `http_method` is required: a request
without it is refused with a 401, whatever credential it carries. EndPointBlank ignores any other
key in the body, so a misspelled field does not fail — it is simply never received.

`path` is the **route pattern, composed with the prefix the router is mounted under** — a router
mounted at `/students` declaring `router.get('/:id')` is reported as `/students/:id`, and its index
route as `/students` rather than `/students/`. That is the same string that
[`registerExpressEndpoints`](#declaring-endpoint-versions--registering-routes) publishes for the
route, and it has to be: EndPointBlank resolves the endpoint before it considers the credential,
and matches the path exactly. A guard naming the route any other way is refused for having no such
endpoint — which reads like a missing grant on a credential that is perfectly good.

Handle `UnauthorizedError` explicitly (it is intentionally *not* reported as an application error —
see [Request/response/error/log reporting](#requestresponseerrorlog-reporting)):

```js
app.use((err, req, res, next) => {
  if (err.name === 'UnauthorizedError') {
    return res.status(err.statusCode).json({ error: err.message });
  }
  next(err);
});
```

`statusCode` is intake's own verdict, from either guard. 401 and 403 are different remedies, so
they must not be collapsed:

| intake answered | `err.statusCode` |
| --- | --- |
| 401 | `401` — re-check or re-issue the credential |
| 403 | `403` — ask for a grant covering this endpoint |
| any other non-201 | that status, verbatim |
| nothing at all | `503` — the check could not be made, so nothing judged this caller |

`new UnauthorizedError(message)` still defaults to 401; the status is an optional second argument.

### Authorization headers for your own outbound calls

`Authorization.header(baseUrl)` — required by its real path under `src/`, same as any other
submodule not covered by the `end-point-blank-js`/`/express`/`/middleware` entry points (see
"Note on requiring submodules" above) — builds the `Authorization` header for a call *you* are
making to another EndPointBlank-registered target (a provider). It answers a `Bearer` token for
that target, and nothing else.

**It never falls back to HTTP Basic (sc-1469).** Your `clientId`/`clientSecret` are never sent to a
provider. When no token can be obtained — intake rejected the credential (401) or the request
(other 4xx), intake failed (5xx), or it could not be reached (timeout, connection refused) —
`header()` rejects with `TokenUnavailableError` instead of producing a header. Anything else that
throws while minting (a bug, not an unreachable intake) is reported the same way, with
`err.unexpected === true` and the thrown error as `err.cause`. Calling it with no URL, or with one
that is not an absolute http or https URL with a host, throws a `TypeError` (the Ruby gem raises
`ArgumentError` for the same thing) and makes no request; there is no credential-based form. A
missing `clientId` or `clientSecret` throws `ConfigurationError` and makes no request: it is not
reported as a rejected credential.

```js
const epb = require('end-point-blank-js');
const { Authorization } = require('end-point-blank-js/src/authorization');

try {
  // Pass the URL you are about to call, NOT a hostname.
  // userinfo, query and fragment are removed before the token request; they are
  // never sent to intake, logged, or kept on the error.
  const authHeader = await Authorization.header('https://api.example.com/orders');
  // ... call the provider with { Authorization: authHeader }
} catch (err) {
  if (!(err instanceof epb.TokenUnavailableError)) throw err; // TypeError, ConfigurationError
  // err.outcome: an epb.TokenOutcome value; a mint that threw is TRANSPORT_ERROR with
  //              err.unexpected === true (see err.cause)
  // err.status:  intake's HTTP status, or null when none was obtained
  // err.baseUrl: the URL the token was requested for: scheme, host, port (not the
  //              scheme's default) and path only
  if (err.outcome === epb.TokenOutcome.CREDENTIAL_REJECTED) {
    // Permanent: re-issue this application's credential.
  } else {
    // Do not call the provider unauthenticated or with other credentials;
    // fail the operation, or retry later for a transient outcome.
  }
}
```

The error's message says which of these happened, for example:

```
Could not mint an EndPointBlank access token for https://api.example.com/orders: intake could
not be reached (timeout, connection refused or retries exhausted); this may be transient.
EndPointBlank never sends this service's client_id/client_secret to a provider, so there is no
Basic-auth fallback and the call must not be made without a token.
```

The argument is the URL you are about to call. Intake matches it against the registered base URLs
by longest path prefix, so you do not need to know how the target registered itself —
`https://api.example.com/orders/widgets/42` resolves to whichever environment owns it.

Tokens are cached per application environment, keyed on the canonical base URL intake resolves the
request to (not on the URL you passed), so a service that calls several targets holds a token for
each.

#### Why a token could not be obtained

`Authorization.header(baseUrl)` carries the reason on the `TokenUnavailableError` it throws
(`outcome`, `status`). The lower-level `AccessTokens.token(baseUrl)` answers `null` and does not
say *why* on its own, and the difference matters: a
`401` from intake means the client credential is invalid or revoked and no amount of retrying will
change that, while a `5xx` or a dropped connection is worth trying again. A `400` or `422` is
permanent too, but the fix is the request or the target's registration rather than the credential.

Two additive entry points expose that. Both are optional — the existing return contracts are
unchanged.

```js
const epb = require('end-point-blank-js');
const { AccessTokens } = require('end-point-blank-js/src/tokens/access-tokens');

const token = await AccessTokens.token('https://api.example.com/orders');
if (!token) {
  const failure = AccessTokens.lastFailure('https://api.example.com/orders');
  // => null, or { outcome, status }
  if (failure && failure.outcome === epb.TokenOutcome.CREDENTIAL_REJECTED) {
    // Permanent: re-issue the credential. Retrying only produces another 401.
  }
}
```

`lastFailure(baseUrl)` is keyed on the URL you asked for (a failed mint never learns the canonical
base URL), holds only the most recent failure for it, and is cleared by the next successful mint.

For the raw exchange, `GenerateAccessToken.tokenResult(baseUrl)` returns
`{ outcome, status, payload }` rather than the payload alone:

| `outcome` | HTTP | Meaning |
| --- | --- | --- |
| `TokenOutcome.SUCCESS` | 2xx | A token was minted: the body parsed and carries a non-empty `token` and `base_url`. Nothing else is a success. |
| `TokenOutcome.CREDENTIAL_REJECTED` | 401 | Invalid or revoked credential. Permanent — re-issue it. |
| `TokenOutcome.REQUEST_REJECTED` | other 4xx | Bad request (400) or no matching application (422). Permanent — fix the request or the registration. |
| `TokenOutcome.SERVER_ERROR` | 5xx, or an unusable 2xx | Intake failed, or answered a 2xx no token could be read out of. Transient. Keeps the real status, including when that was a 2xx. |
| `TokenOutcome.TRANSPORT_ERROR` | — | No HTTP status was obtained at all: timeout, connection refused, retries exhausted. Transient. |

The status decides the outcome, and a body that will not parse never overrides it — a proxy in
front of intake can answer `401` with an HTML page, and that credential is being refused just as
surely as one refused in JSON. Only on a `2xx` does the body get a say, and only because there is
nothing else to go on: the status said yes, so a body the SDK cannot read a token out of — it would
not parse, it carries no `token`, or it carries a `token` and no `base_url` — is a broken server,
reported as `SERVER_ERROR` under its real `2xx` status.

So `outcome === TokenOutcome.SUCCESS` is safe to branch on by itself; you never have to re-check
`payload.token` by hand. `payload` still carries whatever body came back, including on a `2xx`
classified `SERVER_ERROR`, and `GenerateAccessToken.token(baseUrl)` returns it unchanged.

`status` carries the numeric status (or `null` when the request never landed) so you can be more
precise than the outcome name when you need to be.

### Declaring endpoint versions &amp; registering routes

Tag a route handler with the API version(s) it supports, then publish your route table to
EndPointBlank once at startup:

```js
const { versioned, registerExpressEndpoints } = require('end-point-blank-js/express');

router.get('/api/users', versioned(['1', '2']), listUsers);
router.get('/api/legacy-report', versioned(['1']), legacyReport);

app.listen(3000, () => registerExpressEndpoints(app));
```

`registerExpressEndpoints` walks the Express router tree and only reports routes that were tagged
with `versioned(...)` — untagged routes are skipped. Note `versioned([])` still counts as tagged:
the route is reported with no version attached.

Lifecycle state (Current, Deprecated, …) is **not** declared here — it is managed in the
EndPointBlank portal, where changing it does not require shipping code. This reports which versions
a route serves, and nothing about what they mean. Each request's own API version is detected
automatically (in order: a custom `versionFinder`, then the `Accept` header, `X-Api-Version`
header, `Content-Type` header, a `?version=` query parameter, or a `/v1/...` path segment).

### Request/response/error/log reporting

The `reportInteraction` Express middleware (shown in [Quick start](#quick-start)) automatically:

- stores the current request in an `AsyncLocalStorage` context (`RequestStore`) so later reporting
  calls in the same request can find it,
- writes a request payload as soon as the request comes in,
- writes a response payload when `res` emits `'finish'`,
- and, via the companion `reportInteractionErrorHandler`, writes an exception payload for any error
  passed to `next(err)` — except `UnauthorizedError`, which is deliberately not reported since
  unauthorized attempts are expected traffic, not application bugs.

Report a log line or a caught exception manually from anywhere in your request-handling code:

```js
const { LogWriter } = require('end-point-blank-js/src/writers/log-writer');
const { ExceptionWriter } = require('end-point-blank-js/src/writers/exception-writer');

await LogWriter.info('Payment processed', { amount: 42, currency: 'USD' });
await LogWriter.warn('Retrying downstream call', { attempt: 2 });
await LogWriter.error('Downstream call failed', { attempt: 3 });
await LogWriter.fatal('Out of retries, giving up', { orderId });

try {
  riskyOperation();
} catch (err) {
  await ExceptionWriter.write(err); // reports message + stacktrace + request context
  throw err;
}
```

All writers respect `config.logMode`: `LogMode.DIRECT` (the default) POSTs synchronously and
awaits the result; `LogMode.DELAYED` enqueues the payload and flushes it in the background in
batches of 4, bounded at 1000 queued payloads (oldest dropped first if the queue backs up during
an outage). Every write is best-effort — reporting failures are logged to `console.error`/
`console.warn` and never throw back into your application code.

### Data masking

Mask sensitive data **client-side, before it leaves your app**. Configure an ordered list of
rules; each rule targets one field and masks by a JSONPath, a regex, or both. (The EndPointBlank
intake service also masks independently server-side, so this is defense in depth, not a
replacement.)

```js
epb.configure({
  maskingRules: [
    // Replace any "ssn" field at any depth in the request body.
    { target: 'request_body', path: '$..ssn', replacement_value: '***' },
    // Keep first/last 4 of a card number in error messages via backreferences.
    { target: 'error_message', regex: '(\\d{4})-\\d{4}-\\d{4}-(\\d{4})', replacement_value: '$1-****-****-$2' },
    // Redact a custom API-key header from reported requests.
    { target: 'request_headers', path: "$['x-api-key']", replacement_value: '...' },
  ],
  // Optional: runs after all rules; last chance to transform the payload.
  maskHook: (payload, recordType) => payload,
});
```

**Rule fields**

- `target` — exactly one of `request_body`, `request_headers`, `path`, `response_body`,
  `error_message`.
- `path` — an optional JSONPath (supported subset: `$`, `.name`, `['name']` / `["name"]`, `[n]`,
  `.*` / `[*]`, and `..name` for recursive descent). Keys are case-sensitive.
- `regex` — an optional regular expression (as a string, compiled with the `g` flag internally).
- `replacement_value` — the replacement string (default `'...'`).

**Semantics — path scopes, regex matches within.** With only a `path`, the selected node is
replaced entirely. With only a `regex`, every matching string is replaced. With both, the regex is
applied only within the path-selected node(s). When a `regex` is present, `replacement_value`
supports backreferences: `$1`, `$2`, … insert capture groups (`$0` is the whole match, `$$` is a
literal `$`, and an out-of-range/non-participating group expands to `''`). `stacktrace` and log
messages are never masked.

Masking runs inside each writer (`RequestWriter`, `ResponseWriter`, `ExceptionWriter`) against the
actual outgoing wire payload — `request_body` targets the `request` key, `request_headers` targets
`headers`, `response_body` targets `body`, `error_message` targets `message`, and `path` targets
`path`. `LogWriter` log entries are not affected by masking rules (there is no `log` field
mapping).

**Credential and cookie headers are never sent.** Before any rule runs, `RequestWriter` drops
`Authorization`, `Proxy-Authorization` and `Cookie` from the request record, and `ResponseWriter`
drops `Set-Cookie` from the response record, whatever their letter case. They are left out of the
record, not masked: they are not in the payload the rules and hook receive. The list is
`SENSITIVE_HEADERS` in `src/sensitive-headers.js`.

## Management API

`ManagementClient` calls the EndPointBlank management API (`/api/v1`): the things an organization
admin does in the portal (API packages, clients, package assignments, grants, applications,
environments, runtime credentials), done from code. It is separate from the runtime client above:

- It authenticates with a **management API key** (`epb_mk_...`, created in the portal under
  Settings > API Keys), sent only as `Authorization: Bearer` and only to its own `baseUrl`. It
  never reads `configure()`'s settings or any `ENDPOINTBLANK_*` variable, and never sends a
  runtime `clientId`/`clientSecret` (the management API refuses them anyway).
- It loads from its own entry point, `end-point-blank-js/management`, so an application that
  only uses the runtime client never loads it. TypeScript declarations ship with it
  (`src/management/index.d.ts`).
- The key is held privately: `util.inspect`, `JSON.stringify` and `String()` of the client show
  `epb_mk_[REDACTED]`, and no error carries it. The client logs nothing.
- `baseUrl` must be `https`; plain `http` is allowed only for `localhost`, `127.0.0.1` and
  `[::1]`, so the key never crosses a network in cleartext. Redirects are not followed.
- An id made only of dots (`.`, `..`) is refused with a `TypeError` before any request: it would
  otherwise be resolved as a path dot-segment and reach a different resource.

### Quickstart

```js
const { ManagementClient, ManagementApiError, ErrorCode } = require('end-point-blank-js/management');

const mgmt = new ManagementClient({
  apiKey: process.env.EPB_MGMT_KEY, // epb_mk_...
  // baseUrl: 'https://app.endpointblank.com', // the default; no /api/v1
});

const org = await mgmt.organization.get(); // { id, name, slug, key: { name, scope } }

// Lists: one page, or every item with `for await` (pages follow next_cursor for you)
const page = await mgmt.clients.list({ limit: 100 }); // { data, next_cursor }
for await (const client of mgmt.clients.listAll({ limit: 100 })) {
  console.log(client.name, client.status);
}

// Invite a client, and assign it an API package
const apiPackage = await mgmt.apiPackages.create({ name: 'Partner tier' });
const { data: [endpoint] } = await mgmt.endpoints.list({ application_id: appId });
await mgmt.apiPackages.endpoints.add(apiPackage.id, {
  application_id: appId,
  endpoint_id: endpoint.id, // omit for every endpoint of the application
  environment_id: productionId,
});

const client = await mgmt.clients.create({
  name: 'Acme Corp',
  contacts: [{ email: 'dev@acme.example', first_name: 'Dana', last_name: 'Lee' }],
});
// client.invite_code is what Acme accepts the invite with (write keys only).
await mgmt.clients.packages.assign(client.id, {
  api_package_id: apiPackage.id,
  environment_id: productionId,
}); // status "pending" until Acme accepts, then "active"

// Runtime credentials: the secret is in the create/rotate answer and nowhere else
const credential = await mgmt.credentials.create({ application_environment_id: appEnvId });
store(credential.client_id, credential.client_secret);
const rotated = await mgmt.credentials.rotate(credential.id); // old secret works for the grace window
store(rotated.client_id, rotated.client_secret);
await mgmt.credentials.revoke(credential.id);

// Errors: match on code
try {
  await mgmt.clients.create({ name: 'One more' });
} catch (err) {
  if (!(err instanceof ManagementApiError)) throw err;
  switch (err.code) {
    case ErrorCode.PLAN_LIMIT: // 402
      break;
    case ErrorCode.VALIDATION_FAILED: // 422; err.details lists the fields
      console.error(err.details);
      break;
    default:
      throw err; // err.status, err.message, err.requestId
  }
}
```

Request bodies and answers use the API's own field names (snake_case), as documented at
`/docs/management-api` and in `GET /api/v1/openapi.json`. Single-resource calls answer the `data`
object (a delete answers `{ id, deleted: true }`); `apiPackages.endpoints.add`/`remove` answer
`{ data, warnings }`, where `warnings` lists client assignments that now derive no grant. Each
list resource has `list(params)` (one page), `listAll(params)` (each item) and `pages(params)`
(each page); `limit` is 1 to 100 (default 50).

| Resource | Methods |
|---|---|
| `organization` | `get()` |
| `apiPackages` | `list`, `listAll`, `pages`, `create`, `get`, `update`, `delete` |
| `apiPackages.endpoints` | `list(packageId)`, `listAll`, `pages`, `add(packageId, body)`, `remove(packageId, accessId)` |
| `endpoints` | `list({ application_id, version })`, `listAll`, `pages` |
| `clients` | `list`, `listAll`, `pages`, `create` (invite, or `managed: true`), `get`, `update(id, { owner_email })`, `delete`, `claimInvite(clientId, { email, return_to })`, `createPortalSession(clientId, { return_url })` |
| `clients.packages` | `list(clientId)`, `listAll`, `pages`, `assign(clientId, body)`, `update(clientId, id, { environment_id })`, `remove(clientId, id)` |
| `clients.grants` | `list(clientId)`, `listAll`, `pages`, `create(clientId, body)`, `revoke(clientId, id)` |
| `applications` | `list`, `listAll`, `pages`, `create`, `get`, `update`, `delete` |
| `applications.environments` | `list(applicationId)`, `listAll`, `pages`, `create(applicationId, { environment_id, base_url })`, `delete(applicationId, id)` |
| `environments` | `list`, `listAll`, `pages`, `create`, `get`, `update`, `delete` |
| `credentials` | `list({ application_environment_id })`, `listAll`, `pages`, `get`, `create`, `rotate`, `revoke` |

### Managed clients

A managed client is a client organization you create and run for your customer until they claim
it. `forManagedClient(id)` gives the same `applications`, `environments` and `credentials` calls,
made under `/clients/:client_id/...` for that client:

```js
// `owner_email` (optional) names the person at your customer who will own it;
// change it later with `mgmt.clients.update(managed.id, { owner_email })`.
const managed = await mgmt.clients.create({
  name: 'Globex',
  managed: true,
  owner_email: 'owner@globex.example',
});
const globex = mgmt.forManagedClient(managed.id);

const env = await globex.environments.create({ name: 'production-eu', domain: 'eu.globex.example' });
const app = await globex.applications.create({
  name: 'Globex backend',
  environment_base_urls: { [env.id]: 'https://api.globex.example' },
});
const { data: [appEnv] } = await globex.applications.environments.list(app.id);
const credential = await globex.credentials.create({ application_environment_id: appEnv.id });

// Packages and grants are assigned to it like any accepted client's
await mgmt.clients.packages.assign(managed.id, { api_package_id: apiPackage.id, environment_id: productionId });

// Hand it over: the customer claims it by accepting this emailed invite
await globex.claimInvite({ email: 'owner@globex.example' });

// Or send their browser back to your app once they have claimed it
await globex.claimInvite({
  email: 'owner@globex.example',
  return_to: 'https://app.example.com/onboarding/globex',
});

// Until they claim it, send its owner into its EndPointBlank portal from your
// app: mint a link when they click and redirect their browser to it. The link
// works once and expires after 60 seconds, so never render it into a page, and
// mint a new one (with a new Idempotency-Key, the default) on every click.
// `return_url` (optional) must be one of your claim return URLs too.
const { url } = await globex.createPortalSession({
  return_url: 'https://app.example.com/onboarding/globex',
});
// e.g. in an Express handler: res.redirect(303, url);
```

`return_to` is optional and is sent only when you give it. It must equal, byte for byte, a claim
return URL your organization registered in EndPointBlank; otherwise the call answers 422
`return_to_not_registered` (`ErrorCode.RETURN_TO_NOT_REGISTERED`). After the customer claims the
client, EndPointBlank redirects their browser to it.

`createPortalSession` answers `{ client_id, url, expires_at, return_url }` (`return_url` is
`null` when none was given), and sends a body only when you give `return_url`. It is refused with
404 `not_found` for a client that is not yours, and 422 `client_not_managed` (not a managed
client, or already claimed), `client_being_removed`, `owner_email_missing` (set one with
`clients.update`) or `return_url_not_registered`. Its answer is never replayed: a reused
Idempotency-Key answers 409 `idempotency_replay_unavailable`, so never pass the same
`idempotencyKey` for two clicks.

Once the customer claims it, every `forManagedClient` call for it answers 404 `not_found`.

### Retries, idempotency and errors

- Every POST sends an `Idempotency-Key`: a generated UUID, or yours with
  `{ idempotencyKey: '...' }` as the last argument. Every retry of that call sends the same key,
  so the server runs it once.
- A 429 `rate_limited` waits the `Retry-After` seconds and tries again. 5xx answers (such as
  `audit_unavailable`, `intake_unavailable`, `internal_server_error`) and network errors are
  retried for GET, DELETE and POST, with backoff; a PATCH is never retried once it may have
  reached the server. A 409 `idempotency_request_in_progress` is retried with the same key.
- At most `maxRetries` retries (default 2); `maxRetries: 0` (or `false`) turns retrying off. A
  `Retry-After` longer than `maxRetryWaitMs` (default 60000) is thrown instead of waited on.
  Other options: `timeoutMs` per attempt (default 30000), `retryBaseDelayMs` (default 500),
  `fetch` and `sleep` (for tests).
- 409 `idempotency_replay_unavailable` is never retried: the first POST with that key worked, but
  its answer held a one-time secret (a credential create or rotate, or a portal session's link)
  that can't be shown again. Read or list the resource (`err.location` names it) instead; rotate
  again only if you must. For a portal session, create a new one with a new key.
- Every failure is a `ManagementApiError` with `code`, `message`, `details`, `status`,
  `retryAfter`, `method`, `path`, `idempotencyKey`, `location` and `requestId`. `ErrorCode`
  lists the documented codes; a code this SDK does not know yet still arrives as sent. The SDK's
  own codes are `network_error` (no answer; `status` is `null`), `http_error` (an error answer
  without the JSON error body) and `invalid_response`.
- `delete_refused` (credential revoke) is not retried automatically: the credential is already
  revoked on intake; retry the DELETE yourself.

## Framework integration

Express is the only framework this SDK integrates with directly (it's an optional peer
dependency). The pieces are:

| Module | Path | Purpose |
|---|---|---|
| `reportInteraction`, `reportInteractionErrorHandler` | `end-point-blank-js/middleware` | Auto-report every request/response and unhandled error. |
| `authenticated` | `end-point-blank-js/express` | Route guard: enforce authentication. |
| `authorized` | `end-point-blank-js/express` | Route guard: enforce per-endpoint authorization. |
| `versioned`, `getVersions` | `end-point-blank-js/express` | Tag a route handler with supported API versions. |
| `registerExpressEndpoints`, `collectEndpoints` | `end-point-blank-js/express` | Walk the Express router tree and publish tagged endpoints to EndPointBlank. |

Full wiring example:

```js
const express = require('express');
const epb = require('end-point-blank-js');
const { reportInteraction, reportInteractionErrorHandler } = require('end-point-blank-js/middleware');
const { authenticated, authorized, versioned, registerExpressEndpoints } =
  require('end-point-blank-js/express');

epb.configure({
  clientId: process.env.ENDPOINTBLANK_CLIENT_ID,
  clientSecret: process.env.ENDPOINTBLANK_CLIENT_SECRET,
  appName: 'my-app',
  environment: process.env.NODE_ENV,
});

const app = express();
app.use(express.json());
app.use(reportInteraction);

const router = express.Router();
router.get(
  '/api/users/:id',
  authenticated,
  authorized,
  versioned(['1']),
  (req, res) => res.json({ id: req.params.id }),
);
app.use(router);

app.use(reportInteractionErrorHandler);
app.use((err, req, res, next) => {
  const status = err.name === 'UnauthorizedError' ? err.statusCode : 500;
  res.status(status).json({ error: err.message });
});

app.listen(3000, () => registerExpressEndpoints(app));
```

No integration is currently provided for other frameworks (Koa, Fastify, Next.js, plain
`http.Server`, etc.) — `RequestStore.run(request, fn)`, the individual writers, and the masking
engine are all framework-agnostic, so they can be wired into another framework's middleware layer,
but there is no ready-made adapter today.

## Development

```sh
npm install      # install dependencies
npm test         # run the Jest suite with coverage (jest --coverage)
```

The management client's live test (`tests/management/integration.test.js`) is skipped unless
`EPB_MGMT_BASE_URL` (for example `http://localhost:4000`) and `EPB_MGMT_KEY` (a write-scope
`epb_mk_...` key) are set; it creates what it uses and removes it again.

`./build.sh` and `./test.sh` wrap the same commands and are what CI (`.github/workflows/ci.yml`)
runs on every push/PR to `master`. A separate `publish.yml` workflow publishes to npm on GitHub
Release, once the `NPM_TOKEN` repo secret is configured.

**Layout:**

```
src/
  index.js                     # Public entry point: configure(), VERSION, LogMode, UnauthorizedError
  version.js                   # VERSION, read from package.json so it cannot drift
  configuration.js             # Configuration singleton + ENDPOINTBLANK_* env fallbacks
  session-configuration.js     # environment name resolution for error payloads
  authorization.js             # Bearer header for provider calls; Basic for intake only
  token-unavailable-error.js   # Thrown when no provider token can be obtained
  unauthorized-error.js        # UnauthorizedError
  request-store.js             # AsyncLocalStorage-based per-request context
  payload-builder.js           # Builds application-error payloads for intake's error ingest
  log-entry.js                 # LogEntry value object
  masking.js                   # JSONPath + regex masking engine
  sensitive-headers.js         # SENSITIVE_HEADERS: never sent in a request or response record
  fast-json-truncator.js       # JSON truncation helper
  xml-truncator.js             # XML truncation helper
  string-truncator.js          # String truncation helper
  middleware/
    report-interaction.js      # Express middleware: request/response/error reporting
                                # (also the `end-point-blank-js/middleware` export)
  express/
    index.js                   # Aggregates the exports below (the `end-point-blank-js/express` export)
    authenticated.js           # Route guard
    authorized.js              # Route guard
    versioned.js               # Endpoint version tagging
    endpoint-registrar.js      # Publishes tagged routes to EndPointBlank
  writers/
    writer.js, direct-writer.js, delayed-writer.js
    request-writer.js, response-writer.js, exception-writer.js, log-writer.js
  tokens/
    access-tokens.js           # Access-token cache, keyed on the base URL intake resolves to
  management/                  # Management API client (the `end-point-blank-js/management` export)
    index.js, index.d.ts       # Exports and TypeScript declarations
    client.js                  # ManagementClient: options, key checks, resources
    resources.js               # One class per /api/v1 route group, plus pagination
    transport.js               # fetch, Bearer key, Idempotency-Key, retries
    errors.js                  # ManagementApiError and ErrorCode
  commands/
    _http.js                   # Shared fetch()-based POST helper (timeout + retry)
    basic-authenticate.js, endpoint-authorize.js, endpoint-update.js
    generate-access-token.js, authentication-cache.js
    version-finder.js, route-pattern-finder.js
    bearer-generate.js
tests/                          # Jest test suite mirroring the src/ layout
```

## License

Proprietary — all rights reserved. See [`LICENSE`](./LICENSE).

## Links

- Repository: https://github.com/EndPointBlank/end_point_blank_js
