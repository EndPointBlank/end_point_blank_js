# EndPointBlank (JavaScript)

Node.js client for EndPointBlank: endpoint tracking, request/response/error/log reporting, route
authorization &amp; authentication, and client-side data masking — with an optional Express
integration.

## Installation

This package is **not yet published to npm**. Until it is, install it directly from GitHub:

```sh
npm install github:EndPointBlank/end_point_blank_js
# or a pinned ref:
npm install github:EndPointBlank/end_point_blank_js#v0.2.1
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
  require('end-point-blank-js/src/middleware/report-interaction');

app.use(reportInteraction);
app.use(yourRoutes);
app.use(reportInteractionErrorHandler); // must be registered after your routes
```

> **Note on requiring submodules:** the package's `main` entry (`src/index.js`) only exports the
> top-level `configure`/`VERSION`/`LogMode`/`UnauthorizedError`/`config` API. Everything else
> (middleware, Express route guards, `LogWriter`, etc.) currently has no `package.json` `exports`
> map or subpath `index.js`, so it must be required by its real path under `src/`, e.g.
> `require('end-point-blank-js/src/middleware/report-interaction')` or
> `require('end-point-blank-js/src/express/versioned')`. Paths like
> `end-point-blank-js/middleware` or `end-point-blank-js/express` (as shown in some inline JSDoc
> comments in this codebase) do **not** currently resolve — use the `src/...` paths shown in this
> README.

## Configuration

Call `configure({...})` once, typically at application boot. Every option is optional — only the
keys you pass are updated, and calling `configure` again merges into the existing configuration
(it does not reset unspecified keys).

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
| `cacheTtl` | — | `300` | Seconds; TTL for the authentication-cache entries used by the `authenticated`/`authorized` Express guards. |
| `workerCount` | — | `4` | Reserved for parity with the Ruby gem's threaded writer pool; not currently consumed by any JS code path (Node is single-threaded, so "delayed" mode uses `setImmediate` batching instead). |
| `maskingRules` | — | `[]` | See [Data masking](#data-masking). |
| `maskHook` | — | `null` | See [Data masking](#data-masking). |

Note: `environment` resolution differs slightly depending on where it's read from. `config.environment`
itself resolves `explicit > ENDPOINTBLANK_ENV > null`. Error-report payloads (built via
`PayloadBuilder`/`SessionConfiguration.envName()`) go one step further: `explicit > ENDPOINTBLANK_ENV
> NODE_ENV > 'production'`.

There is no env-var fallback for `applicationVersion`, `versionFinder`, `logMode`, `tokenTtl`,
`cacheTtl`, `workerCount`, `maskingRules`, or `maskHook` — those must be set via `configure()`.

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
const { authenticated } = require('end-point-blank-js/src/express/authenticated');
const { authorized } = require('end-point-blank-js/src/express/authorized');

// authenticated: verifies the caller's credentials
router.get('/protected', authenticated, (req, res) => res.json({ ok: true }));

// authorized: verifies the caller is allowed to hit this specific endpoint
router.get('/sensitive', authorized, (req, res) => res.json({ ok: true }));

// Either can be applied router-wide too:
router.use(authenticated);
```

Successful `authorized` checks are cached in-process (keyed on credentials + path + method +
`appName`) for `cacheTtl` seconds, so repeat calls to the same endpoint skip the network round
trip. Authorization requests use a cached Bearer token per target hostname when available, falling
back to HTTP Basic auth built from `clientId`/`clientSecret` (`Authorization.header()`).

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

### Declaring endpoint versions &amp; registering routes

Tag a route handler with the API version(s) it supports, then publish your route table to
EndPointBlank once at startup:

```js
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { registerExpressEndpoints } = require('end-point-blank-js/src/express/endpoint-registrar');

router.get('/api/users', versioned(['1', '2'], { state: 'Current' }), listUsers);
router.get('/api/legacy-report', versioned(['1'], { state: 'Deprecated' }), legacyReport);

app.listen(3000, () => registerExpressEndpoints(app));
```

`registerExpressEndpoints` walks the Express router tree and only reports routes that were tagged
with `versioned(...)` — untagged routes are skipped. Each request's own API version is detected
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
    // Redact the Authorization header from reported requests.
    { target: 'request_headers', path: '$.authorization', replacement_value: '...' },
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

## Framework integration

Express is the only framework this SDK integrates with directly (it's an optional peer
dependency). The pieces are:

| Module | Path | Purpose |
|---|---|---|
| `reportInteraction`, `reportInteractionErrorHandler` | `end-point-blank-js/src/middleware/report-interaction` | Auto-report every request/response and unhandled error. |
| `authenticated` | `end-point-blank-js/src/express/authenticated` | Route guard: enforce authentication. |
| `authorized` | `end-point-blank-js/src/express/authorized` | Route guard: enforce per-endpoint authorization. |
| `versioned`, `getVersions` | `end-point-blank-js/src/express/versioned` | Tag a route handler with supported API versions. |
| `registerExpressEndpoints`, `collectEndpoints` | `end-point-blank-js/src/express/endpoint-registrar` | Walk the Express router tree and publish tagged endpoints to EndPointBlank. |

Full wiring example:

```js
const express = require('express');
const epb = require('end-point-blank-js');
const { reportInteraction, reportInteractionErrorHandler } =
  require('end-point-blank-js/src/middleware/report-interaction');
const { authenticated } = require('end-point-blank-js/src/express/authenticated');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { registerExpressEndpoints } = require('end-point-blank-js/src/express/endpoint-registrar');

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
  versioned(['1'], { state: 'Current' }),
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

`./build.sh` and `./test.sh` wrap the same commands and are what CI (`.github/workflows/ci.yml`)
runs on every push/PR to `master`. A separate `publish.yml` workflow publishes to npm on GitHub
Release, once the `NPM_TOKEN` repo secret is configured.

**Layout:**

```
src/
  index.js                     # Public entry point: configure(), VERSION, LogMode, UnauthorizedError
  configuration.js             # Configuration singleton + ENDPOINTBLANK_* env fallbacks
  session-configuration.js     # environment name resolution for error payloads
  authorization.js             # Basic/Bearer auth header generation
  unauthorized-error.js        # UnauthorizedError
  request-store.js             # AsyncLocalStorage-based per-request context
  payload-builder.js           # Builds error-report payloads
  log-entry.js                 # LogEntry value object
  masking.js                   # JSONPath + regex masking engine
  fast-json-truncator.js       # JSON truncation helper
  xml-truncator.js             # XML truncation helper
  string-truncator.js          # String truncation helper
  middleware/
    report-interaction.js      # Express middleware: request/response/error reporting
  express/
    authenticated.js           # Route guard
    authorized.js              # Route guard
    versioned.js               # Endpoint version tagging
    endpoint-registrar.js      # Publishes tagged routes to EndPointBlank
  writers/
    writer.js, direct-writer.js, delayed-writer.js
    request-writer.js, response-writer.js, exception-writer.js, log-writer.js
  tokens/
    access-tokens.js           # Bearer token cache/refresh per hostname
  commands/
    _http.js                   # Shared fetch()-based POST helper (timeout + retry)
    basic-authenticate.js, endpoint-authorize.js, endpoint-update.js
    generate-access-token.js, authentication-cache.js
    version-finder.js, route-pattern-finder.js
    bearer-generate.js
tests/                          # Jest test suite mirroring the src/ layout
```

## License

MIT — see the `license` field in `package.json`.

## Links

- Repository: https://github.com/EndPointBlank/end_point_blank_js
