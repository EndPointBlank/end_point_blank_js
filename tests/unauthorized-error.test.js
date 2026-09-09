'use strict';

const { UnauthorizedError, refusalFrom } = require('../src/unauthorized-error');

/**
 * The status carried here is what a provider's error handler turns into an
 * HTTP status — the README's own suggested handler is
 * `res.status(err.statusCode)`. A refusal that loses it tells every caller to
 * go and check a credential, including the ones whose credential is fine.
 */
/**
 * GUARDS, not regression tests: every test in this block passes against the
 * pre-change code. The class already accepted and stored a status — that was
 * never the gap. The gap was that `authenticated` never passed one, so these
 * pin the contract the guards now rely on, and pin that the single-argument
 * construction the README documents keeps working.
 */
describe('UnauthorizedError', () => {
  describe('the status it carries', () => {
    test('defaults to 401 when constructed with a message alone', () => {
      const error = new UnauthorizedError('no credentials');

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('no credentials');
    });

    test('is the one it was given', () => {
      expect(new UnauthorizedError('not entitled', 403).statusCode).toBe(403);
    });
  });

  // `instanceof Error` and the `name` are what `reportInteractionErrorHandler`
  // and the README's `err.name === 'UnauthorizedError'` check both depend on.
  test('is a real Error named UnauthorizedError', () => {
    const error = new UnauthorizedError('no');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnauthorizedError');
  });
});

/**
 * `refusalFrom` is the single decision both Express guards make about a
 * non-201 answer. It exists because there were two copies of it and only one
 * of them was right.
 */
describe('refusalFrom', () => {
  const jsonResponse = (status, payload) => ({
    status,
    text: async () => JSON.stringify(payload),
  });

  describe('when intake refused the caller', () => {
    test('keeps the status intake decided on', async () => {
      const error = await refusalFrom(
        jsonResponse(403, { error: 'access_denied' }),
        'Authentication'
      );

      expect(error.statusCode).toBe(403);
    });

    test('uses the reason intake gave', async () => {
      const error = await refusalFrom(
        jsonResponse(403, { error: 'access_denied' }),
        'Authentication'
      );

      expect(error.message).toBe('Authentication failed: access_denied');
    });

    test('names the action it was performing', async () => {
      const error = await refusalFrom(
        jsonResponse(403, { error: 'access_denied' }),
        'Authorization'
      );

      expect(error.message).toBe('Authorization failed: access_denied');
    });
  });

  describe('when intake did not answer at all', () => {
    test('says 503, because nothing judged this caller', async () => {
      // 401 would send an integrator to re-issue a credential that was never
      // looked at. The other SDKs all answer 503 for this case.
      const error = await refusalFrom(null, 'Authentication');

      expect(error.statusCode).toBe(503);
    });

    test('says so in the message', async () => {
      const error = await refusalFrom(null, 'Authentication');

      expect(error.message).toBe('Authentication failed: Authentication service unavailable');
    });

    test('treats an undefined response the same as a null one', async () => {
      expect((await refusalFrom(undefined, 'Authorization')).statusCode).toBe(503);
    });
  });

  describe('when intake itself failed', () => {
    test('surfaces the 5xx rather than reporting it as a refusal', async () => {
      // A 500 from intake is not a statement about this caller either, and a
      // 401 would hide an outage behind a credential problem.
      const error = await refusalFrom(jsonResponse(500, { error: 'boom' }), 'Authentication');

      expect(error.statusCode).toBe(500);
    });
  });

  describe('reading the body', () => {
    test('falls back to the raw text when the body is not JSON', async () => {
      // A proxy in front of intake answers with an HTML error page; the
      // operator still needs to see what came back.
      const error = await refusalFrom(
        { status: 502, text: async () => 'Bad Gateway' },
        'Authentication'
      );

      expect(error.message).toBe('Authentication failed: Bad Gateway');
      expect(error.statusCode).toBe(502);
    });

    test('reads the body exactly once', async () => {
      // A `fetch` body can only be consumed once. Reading it twice — json()
      // and then text() — means the second read fails by construction, which
      // is how a non-JSON error body used to lose its text on the
      // authenticate path.
      const text = jest.fn().mockResolvedValue('Bad Gateway');

      await refusalFrom({ status: 502, text }, 'Authentication');

      expect(text).toHaveBeenCalledTimes(1);
    });

    test('still carries the status when the body cannot be read at all', async () => {
      const error = await refusalFrom(
        {
          status: 500,
          text: async () => {
            throw new TypeError('terminated');
          },
        },
        'Authorization'
      );

      expect(error.statusCode).toBe(500);
      expect(error.message).toBe('Authorization failed: Authorization service unavailable');
    });

    test('falls back to the generic reason for an empty body', async () => {
      const error = await refusalFrom({ status: 401, text: async () => '' }, 'Authentication');

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Authentication failed: Authentication service unavailable');
    });

    test('falls back to the raw text for JSON that carries no error key', async () => {
      const error = await refusalFrom(jsonResponse(422, { detail: 'nope' }), 'Authorization');

      expect(error.message).toBe('Authorization failed: {"detail":"nope"}');
    });
  });
});
