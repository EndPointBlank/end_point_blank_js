# Changelog

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
