'use strict';

const { instance: config } = require('./configuration');
const { TokenUnavailableError } = require('./token-unavailable-error');

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
   * @param {string} baseUrl - The URL you are about to call, with any query
   *   string and fragment removed. A token covering it is used, or minted if
   *   necessary.
   * @returns {Promise<string>} `"Bearer <token>"`, and nothing else.
   * @throws {TypeError} if `baseUrl` is missing or empty.
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

    const { AccessTokens } = require('./tokens/access-tokens');
    let token;
    try {
      token = await AccessTokens.token(baseUrl);
    } catch (err) {
      throw new TokenUnavailableError(baseUrl, { cause: err });
    }
    if (token) return `Bearer ${token}`;

    const failure = AccessTokens.lastFailure(baseUrl);
    throw new TokenUnavailableError(baseUrl, {
      outcome: failure ? failure.outcome : null,
      status: failure ? failure.status : null,
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
