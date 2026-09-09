# Changelog

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
