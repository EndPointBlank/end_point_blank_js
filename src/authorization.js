'use strict';

const { instance: config } = require('./configuration');
const { TokenUnavailableError } = require('./token-unavailable-error');
const { stripUrl } = require('./strip-url');

/**
 * Generates HTTP authorization headers.
 *
 * Two different audiences, kept apart on purpose (sc-1469):
 *
 * - {@link Authorization.header} is for a call this application makes to a
 *   **provider** (another EndPointBlank-registered target). It only ever
 *   answers `Bearer <token>`, and throws {@link TokenUnavailableError} when no
 *   token can be obtained. It never falls back to HTTP Basic: a client must
 *   never send its own `clientId`/`clientSecret` to a provider.
 * - {@link Authorization.intakeHeader} is HTTP Basic from the configured
 *   credentials, for the SDK's own calls to EndPointBlank intake
 *   (authenticate, authorize, token minting, endpoint updates, log writers).
 *   Intake already holds this credential. Never use it for a provider.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::Authorization`.
 */
const Authorization = {
  /**
   * Returns a `Bearer <token>` header value for a call to a provider.
   *
   * @param {string} baseUrl - The URL you are about to call. Userinfo, query
   *   and fragment are removed before the token request (see `stripUrl`):
   *   they are never sent to intake, logged, or kept on the error. A token
   *   covering the rest is used, or minted if necessary.
   * @returns {Promise<string>} `"Bearer <token>"`, and nothing else.
   * @throws {TypeError} if `baseUrl` is missing or empty, or is not an
   *   absolute URL with a scheme and host. No request is made.
   * @throws {TokenUnavailableError} if no token could be obtained (the mint
   *   was rejected, intake failed or timed out, or it could not be reached).
   *   No Basic header is ever produced in its place.
   */
  async header(baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl === '') {
      throw new TypeError(
        'Authorization.header(baseUrl) requires the URL of the provider you ' +
          'are calling. There is no credential-based form: this application\'s ' +
          'client credentials are never sent to a provider.',
      );
    }

    // Stripped before anything else sees it, so the token request, the cache
    // keys, the log lines and the error all carry the same safe form.
    const url = stripUrl(baseUrl);
    if (url === null) {
      // The URL itself is left out: it could not be parsed, so there is no
      // telling which part of it is a secret.
      throw new TypeError(
        'Authorization.header(baseUrl) requires an absolute URL with a scheme ' +
          'and host, such as https://api.example.com/orders.',
      );
    }

    const { AccessTokens } = require('./tokens/access-tokens');
    // The reason is read off this call's own attempt, not off
    // AccessTokens.lastFailure() afterwards: that record is shared per URL,
    // and a concurrent call could have replaced or cleared it in between.
    let token;
    let result;
    try {
      ({ token, result } = await AccessTokens.tokenWithResult(url));
    } catch (err) {
      // No status was obtained, so this is a transport error; the thrown
      // error rides along as `cause` and its text stays out of the message.
      throw new TokenUnavailableError(url, { outcome: 'transport_error', cause: err });
    }
    if (token) return `Bearer ${token}`;

    throw new TokenUnavailableError(url, {
      outcome: result ? result.outcome : null,
      status: result ? result.status : null,
    });
  },

  /**
   * Returns an HTTP Basic header value built from the configured client
   * credentials, for the SDK's own calls to EndPointBlank intake **only**.
   *
   * Internal: not for outbound calls to providers. See the module comment.
   *
   * @returns {string} `"Basic <credentials>"`
   */
  intakeHeader() {
    return `Basic ${this.basicCredentials()}`;
  },

  /**
   * Returns the Base64-encoded `clientId:clientSecret` string.
   *
   * @returns {string}
   */
  basicCredentials() {
    const raw = `${config.clientId}:${config.clientSecret}`;
    return Buffer.from(raw).toString('base64');
  },
};

module.exports = { Authorization, TokenUnavailableError };
