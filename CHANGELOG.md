# Changelog

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
