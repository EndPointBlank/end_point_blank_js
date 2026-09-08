# Changelog

## 0.7.0

### Added

- **A token request now reports *why* it failed.** intake answers `401` for a
  credential it will not accept and something else for everything it might
  accept later, but the SDK collapsed every outcome to `null` — so a caller
  could not tell "re-issue the credential" from "try again in a minute".

  `GenerateAccessToken.tokenResult(baseUrl)` returns
  `{ outcome, status, payload }`, where `outcome` is one of
  `TokenOutcome.SUCCESS` (2xx), `CREDENTIAL_REJECTED` (401 — permanent until
  the credential is re-issued), `REQUEST_REJECTED` (any other 4xx — permanent,
  but the remedy is the request or the target's registration),
  `SERVER_ERROR` (5xx) or `TRANSPORT_ERROR` (no HTTP status was obtained at
  all: timeout, connection refused, retries exhausted). `TokenOutcome` is
  exported from the package root alongside `LogMode`.

  The status decides; a body that will not parse never overrides it, since a
  proxy in front of intake can answer `401` with an HTML page. The one
  exception is a `2xx` the SDK cannot read, reported as `SERVER_ERROR`.

- **`AccessTokens.lastFailure(baseUrl)`** returns `null` or
  `{ outcome, status }` for the most recent failed mint for that URL, cleared
  by the next successful one.

- A rejected credential now logs its own explicit line saying the credential
  must be re-issued, instead of the generic "Failed to generate access token"
  message it shared with every transient failure.

### Unchanged

- `GenerateAccessToken.token()` and `AccessTokens.token()`/`exists()` keep
  their exact return contracts — parsed-payload-or-`null` and
  token-string-or-`null`, including `token()` returning the parsed body of a
  non-2xx response. This release is purely additive; no upgrade work is
  required.
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
