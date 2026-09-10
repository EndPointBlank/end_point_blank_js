# Changelog

## 0.11.0

### Fixed

- **A route on a mounted router authenticated as an endpoint that was never
  registered.** `express/authenticated.js` worked the path out itself —
  `req.route?.path || req.path || req.url` — with no `req.baseUrl` and no
  trailing-slash normalization. Registration and `authorized` both go through
  `express/request-path.js`, which exists because intake stores what
  registration told it and matches it exactly (`Intake.PathNormalizer` only
  rewrites `{var}` to `:var`; it does not touch mount points or trailing
  slashes). So the guard asked about a path nothing had registered, and every
  request through it was refused with `missing_target_endpoint` — while
  registration and the authorize path, each looked at on its own, were correct.

  | route | registered, and authorized, as | authenticated as |
  | --- | --- | --- |
  | router mounted at `/whoami`, `router.get('/')` | `/whoami` | `/` |
  | router mounted at `/books`, `router.get('/:id')` | `/books/:id` | `/:id` |
  | `app.get('/whoami')` | `/whoami` | `/whoami` |

  Only the last shape was ever right, which is how this survived: a top-level
  route has no `baseUrl` to drop, so the guard looked correct in exactly the
  arrangement its tests and the quickstart used. Mounting the router — the
  arrangement `app.use('/api', router)` makes ordinary — broke it, and the
  symptom was a blanket refusal that pointed at the credential rather than at
  the path.

### Changed

- The two guards' path resolution is now one function,
  `express/request-path.requestPath`, which the endpoint registrar already used.
  This was the last of the pair's three transcriptions: sc-307 unified the
  refusal, sc-320 the body keys, and the path was the half left unrepaired both
  times. Two copies is how one path acquires a fix the other does not.

### Unchanged

- `authorized`, the endpoint registrar, and `requestPath` itself behave exactly
  as before. Nothing about what gets registered changed; the authenticate guard
  was brought into line with it, not the other way around.
- A top-level route reports the path it always reported. An application whose
  routes are all declared on the app rather than on a mounted router sees no
  difference.

## 0.10.0

### Fixed

- **The exported `PayloadBuilder` built a row intake refuses.** It sent no
  `uuid`, and intake's `ApplicationError` changeset ends
  `validate_required([:message, :uuid, :app_name, :sent_at])`
  (`intake/lib/intake/errors/application_error.ex:46`), so every error report
  built through it was rejected on arrival. `writers/exception-writer.js` — the
  path the Express middleware uses — has always sent one, so applications using
  the middleware were never affected. `package.json` exports `./src/*`, so the
  builder is a documented way in, and it is the one an integrator reaches for
  when they are not running the middleware.

  Until this week the rejection was invisible: intake's error controller
  answered `201 Created` whatever became of the rows. Since sc-310 a batch of
  nothing but rejected rows answers **422**, so a caller on 0.9.0 sees the
  refusal rather than silence. That is a change in what you can see, not in
  what was stored — nothing built this way has ever been stored.

- **Eight of the twelve keys it sent were dropped as unknown.**
  `application_error_controller.ex`'s `build_attrs/2` is an explicit allowlist;
  a key it does not name never reaches the changeset. Two of the eight had
  somewhere to go and were renamed; the other six have no column on
  `application_errors` at all, and what they carry is already recorded on the
  request and response rows for the same call, which the `uuid` joins to.

  | key sent before | what happens to it now |
  | --- | --- |
  | `path` | sent as `stamped_path`, which intake reads |
  | `action` | sent as `stamped_http_method`, which intake reads |
  | `url` | dropped; `application_requests` records `scheme`/`host`/`port`/`path` |
  | `request` | dropped; `application_requests` records it as `request` |
  | `request_headers` | dropped; `application_requests` records them as `headers` |
  | `endpoint_version` | dropped; `application_requests` records it |
  | `status` | dropped; `application_responses` records it |
  | `env` | dropped; intake derives an environment from the credential (sc-321) |

  The payload is now exactly what `build_attrs/2` reads, less the two fields
  intake fills in itself — `stack_hash`, computed server-side from the trace,
  and `target_application_environment_id`, stamped from the credential.

- **`Writer.write` silently discarded a caller-supplied `stacktrace`.** It
  relisted the builder's options and destructured them one at a time, and that
  list had drifted from the builder's: `stacktrace` was missing from it, so
  passing one did nothing. `opts` now goes through whole.

### Added

- `PayloadBuilder.build` accepts a `uuid`, for a caller carrying its own
  correlation id — an inbound `X-Request-Id`, say. When it is not given, the id
  is the one `RequestStore.run` minted for the request in flight, which is the
  same value `RequestWriter`, `ResponseWriter` and `ExceptionWriter` send and
  what joins the error row to the request and response rows for that call.
- Outside a request the builder mints an id rather than sending `null`.
  `ExceptionWriter` sends `null` there, and a `null` is a refused row; building
  outside a request is the normal case for a caller reaching for this module
  directly. An id that correlates with nothing still records the error.
- `source_application_environment_id` is now sent, matching `ExceptionWriter`.
  Intake reads it and previously stored nil on every row built here.

### Changed

- Errors reported through `PayloadBuilder`/`Writer` are stored for the first
  time. Anything reading `application_errors` — the error views, the
  notification fan-out — sees rows from these callers that it has never seen
  before. Rows are not backfilled; nothing was written to backfill from.
- Two of the six dropped keys, `request` and `request_headers`, were the ones
  carrying caller data, and this module never applied the configured masking
  rules to them the way the writers do. Not sending them removes that exposure;
  the masking gap on the one remaining field, `message`, is filed separately.

### Unchanged

- `PayloadBuilder.build` and `Writer.write` keep their signatures. `status`,
  `headers` and `version` are still accepted so existing calls keep working —
  they are simply not sent, as in practice they never were: intake dropped all
  three on arrival.
- `writers/exception-writer.js`, and therefore the Express middleware, is
  untouched. It has sent `uuid`, `stamped_path`, `stamped_http_method` and
  `source_application_environment_id` since it was written; this release brings
  the builder into line with it rather than the other way around.
- `SessionConfiguration` is still exported. No payload uses it any more.

## 0.9.0

### Fixed

- **The `authenticated` guard can now succeed at all.** `BasicAuthenticate`
  posts to intake's `POST /authorize` with a body whose keys intake does not
  read. It sent `action` where intake reads `http_method`, and every clause of
  intake's `AuthorizeAccess.authorize/1` pattern-matches that key — so a body
  without it falls through to the catch-all, which answers `{:error,
  :invalid_params}`, which the controller renders as a **401**. No credential
  this command could present was ever going to be accepted. `authorized` has
  always spelled the key correctly, which is why one guard worked and the other
  never has.

  An integrator using `authenticated` sees a route that returned 401 to every
  caller start returning what its handler returns. Nothing else about the guard
  changed; there was never a state in which it refused *some* callers and
  admitted others.

- **Two fields that were silently discarded are now recorded.** Alongside the
  fatal one, this command sent `version` and `ip_address` where intake reads
  `endpoint_version` and `source_ip`. Intake ignores keys it does not read, so
  these did not fail — they simply never arrived, and intake stored nil in both
  columns on every authenticate row it ever wrote. `endpoint_version` is also
  what the deprecation lookup keys on, so an `authenticated` route could not
  report a deprecated version even in principle.

  | key sent before | key intake reads | what it does there |
  | --- | --- | --- |
  | `action` | `http_method` | matched by every `AuthorizeAccess.authorize/1` clause; without it the call is refused |
  | `version` | `endpoint_version` | the deprecation and sunset lookup, and the `endpoint_version` column |
  | `ip_address` | `source_ip` | stored as `source_ip_address` on the authorization row |

  The keys are sent under one spelling each, not both. Intake would have
  accepted both, which is exactly why sending both would have left the old name
  in place indefinitely for the next port to copy.

### Changed

- Authenticate calls now appear in intake's authorization records with a method,
  a version and a source IP, where previously the row recorded a path and
  nothing else. Anything reading those records — an audit view, a per-IP rule —
  sees populated columns for the first time, on rows going forward only. Rows
  already written stay as they are.

### Unchanged

- `BasicAuthenticate.authenticate(req, path, version, ipAddress)` keeps its
  signature, and the `ipAddress` parameter keeps its name. Only the key it
  travels under changed.
- `EndpointAuthorize` is untouched. It has sent `http_method`,
  `endpoint_version` and `source_ip` since it was written, and this release
  brings the authenticate path into line with it rather than the other way
  around.

## 0.8.0

### Fixed

- **A refusal from the `authenticated` guard now says which refusal it was.**
  `express/authenticated.js` read intake's status at the branch it refused on
  and then threw it away, so every refusal reached the caller as a 401 — the
  status `UnauthorizedError` falls back to — including the 403 that means
  `access_denied`. `authorized` has always passed intake's status through, so
  the same denial gave a caller two different answers depending on which guard
  the route used.

  401 and 403 send an integrator to two different places: *re-check the
  credential* versus *ask for a grant covering this endpoint*. Collapsing them
  sent half of them to debug the wrong thing.

  | intake answered | `err.statusCode` | what it tells the integrator |
  | --- | --- | --- |
  | 401 | `401` | the credential was not accepted — re-check or re-issue it |
  | 403 | `403` | the credential is fine; no grant covers this endpoint |
  | any other non-201 | that status | intake's own verdict, verbatim |
  | nothing at all | `503` | the check could not be made; nothing judged this caller |

  The README's own suggested handler — `res.status(err.statusCode)` — was
  written as though this already worked, and on the `authorized` path it did.
  It now works on both.

- **A refusal from the `authenticated` guard now says *why*, in intake's own
  words.** `BasicAuthenticate` reads the failure body to log it, and it read
  the response itself rather than a clone. A `fetch` body can be consumed once,
  so the guard that reads it afterwards to build the error got nothing, and
  every refusal arrived as "Authentication service unavailable" whatever intake
  had actually said. `EndpointAuthorize` was given this fix and this command was
  not — the same asymmetry, in the same pair of paths, that lost the status.

  This is only visible against a real `fetch` response, which is why no test
  caught it: the failure needs a body that can be read once, and a re-readable
  double cannot express one.

### Changed

- **An unreachable intake is now a 503 to the caller, not a 401.** When intake
  does not answer at all, nothing refused the caller and no credential was
  judged, so blaming the credential sent integrators to re-issue one that was
  fine. This is what `authorized` has always answered for the same case, and
  what the other SDKs answer.
- **An intake 5xx now reaches the caller as that 5xx**, where it previously
  reached them as a 401. This changes what a client of an application using
  `authenticated` sees: an outage in intake presents as an outage rather than as
  a rejected credential. Callers that branch on `401` to trigger a re-login will
  no longer do so for a fault that has nothing to do with their credential.
- The two guards' refusal handling — which was two transcriptions of one
  decision, and had already drifted twice — is now one function,
  `unauthorized-error.refusalFrom`. Two copies is how one path acquires a fix
  the other does not.

### Unchanged

- `new UnauthorizedError(message)` still means what it meant: the status
  defaults to 401. The status remains the optional second argument, and the
  class itself is otherwise untouched — it always accepted a status, which is
  why nothing ever complained that `authenticated` was not passing one.
- `authorized` behaves exactly as before. Its refusal path moved into the shared
  function without changing what it produces for any input.

## 0.7.0

### Added

- **A token request now reports *why* it failed.** intake answers `401` for a
  credential it will not accept and something else for everything it might
  accept later, but the SDK collapsed every outcome to `null` — so a caller
  could not tell "re-issue the credential" from "try again in a minute".

  `GenerateAccessToken.tokenResult(baseUrl)` returns
  `{ outcome, status, payload }`, where `outcome` is one of
  `TokenOutcome.SUCCESS` (a token was minted), `CREDENTIAL_REJECTED` (401 —
  permanent until the credential is re-issued), `REQUEST_REJECTED` (any other
  4xx — permanent, but the remedy is the request or the target's
  registration), `SERVER_ERROR` (5xx, or a 2xx that minted nothing) or
  `TRANSPORT_ERROR` (no HTTP status was obtained at all: timeout, connection
  refused, retries exhausted). `TokenOutcome` is exported from the package
  root alongside `LogMode`.

  `SUCCESS` means a token was minted, and nothing weaker: a 2xx whose body
  parsed and carries a non-empty `token` and a non-empty `base_url`. So
  `outcome === TokenOutcome.SUCCESS` is safe to branch on by itself — if it
  could be true with the token absent, every caller would have to re-check the
  payload by hand, and that is the check that gets forgotten.

  The status decides; a body that will not parse never overrides it, since a
  proxy in front of intake can answer `401` with an HTML page. Only on a 2xx
  does the body get a say: one the SDK cannot read a token out of is reported
  as `SERVER_ERROR` under its real 2xx status. `payload` still carries whatever
  body came back, so nothing is lost — a caller that wants the body of a
  failure reads it from the result.

- **`AccessTokens.lastFailure(baseUrl)`** returns `null` or
  `{ outcome, status }` for the most recent failed mint for that URL, cleared
  by the next successful one.

- A rejected credential now logs its own explicit line saying the credential
  must be re-issued, instead of the generic "Failed to generate access token"
  message it shared with every transient failure.

### Changed

- **`GenerateAccessToken.token(baseUrl)` now answers `null` unless a token was
  actually minted.** It previously returned whatever body came back, whatever
  the status: an `{error: ...}` document from a 401 or 422, or a 2xx that
  parsed into something with no usable token in it. Each of those handed the
  caller a truthy value for a request that produced no token — the same
  failure `tokenResult` was added to remove, one layer down.

  This aligns the four other SDKs with Elixir, whose equivalent has always
  answered `nil` for anything that was not a mint.

  **Upgrade note:** a caller doing `const body = await token(url)` and then
  reading `body.error` gets `null` now. The body has not gone anywhere —
  `tokenResult(url)` returns `{ outcome, status, payload }` and `payload` is
  exactly what `token()` used to hand back. Callers that only ever read
  `body.token` need no change, because a body without a usable token was never
  something they could act on.

### Unchanged

- `AccessTokens.token()`/`exists()` keep their exact return contracts —
  token-string-or-`null`.
- Nothing suppresses retries on a 401 yet. The SDK only makes the outcome
  visible; acting on it is the caller's.

## 0.6.1

### Fixed

- **Diagnostics now go to stderr, not stdout.** Seven `console.info` calls wrote
  to stdout, which Node routes to your application's own output. This package
  runs inside your process, so that corrupts any program whose stdout carries
  structured data — a CLI emitting JSON, a worker writing a protocol stream —
  with no way for you to separate the two.

  If you were relying on SDK log lines appearing on stdout, they now appear on
  stderr. `console.error` and `console.warn` output is unchanged; both already
  wrote to stderr.

## 0.6.0

### Breaking

- **`Authorization.header()` and `AccessTokens.token()` now take a URL, not a
  hostname.** Pass the URL you are about to call —
  `https://api.example.com/orders`, not `api.example.com`. Strip any query
  string or fragment first; they are rejected. Earlier READMEs showed the
  hostname form; those examples no longer work.
- **`AccessTokens.exists()` now requires the same URL argument.** It answers
  for the entry covering that URL; there is no longer a single process-wide
  token for it to answer about.
- **Requires an intake that accepts `base_url`.** An older intake returns
  `400 {"error":"Missing required parameter: base_url"}`.

### Changed

- `endpoint_authorize` authenticates to intake with Basic instead of minting
  an access token for itself. The inbound request path no longer touches the
  token cache at all.
- A 401 from the authorize endpoint is returned to the caller rather than
  retried once. With Basic, a 401 means the credential is wrong.
- Tokens are cached per application environment, keyed on the canonical base
  URL intake resolves the request to, rather than one per process.
