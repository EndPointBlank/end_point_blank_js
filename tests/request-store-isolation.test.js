'use strict';

const { RequestStore } = require('../src/request-store');

/**
 * Request-to-request isolation.
 *
 * Node serves many requests on one thread, so the question is not "can it store
 * a value" but "can one request read another request's value". `AsyncLocalStorage`
 * scopes the context to the async call chain, which rules it out structurally —
 * the JS equivalent of Ruby holding per-request data in the Rack env rather than
 * a thread-local.
 *
 * The interleaved test is the one that matters: two requests in flight at once,
 * each awaiting, with the second finishing first.
 */
describe('RequestStore isolation', () => {
  describe('concurrent requests', () => {
    test('interleaved requests never see each other, even when one finishes first', async () => {
      const observed = [];

      const request = (id, delayMs) =>
        RequestStore.run({ id }, async () => {
          RequestStore.setSourceApplicationEnvironmentId(`env-${id}`);
          RequestStore.setDeprecation({ deprecated_at: `${id}-at` });

          // Yield, letting the other request run and write its own values.
          await new Promise(resolve => setTimeout(resolve, delayMs));

          observed.push({
            id,
            env: RequestStore.getSourceApplicationEnvironmentId(),
            deprecation: RequestStore.getDeprecation()?.deprecated_at,
          });
        });

      // The second starts later and finishes first — a shared slot would be
      // visibly wrong rather than accidentally right through ordering.
      await Promise.all([request('one', 30), request('two', 5)]);

      expect(observed).toContainEqual({ id: 'one', env: 'env-one', deprecation: 'one-at' });
      expect(observed).toContainEqual({ id: 'two', env: 'env-two', deprecation: 'two-at' });
    });

    test('many requests at once each keep their own', async () => {
      const ids = Array.from({ length: 25 }, (_, i) => `req-${i}`);

      const results = await Promise.all(
        ids.map(id =>
          RequestStore.run({ id }, async () => {
            RequestStore.setSourceApplicationEnvironmentId(id);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            return RequestStore.getSourceApplicationEnvironmentId();
          })
        )
      );

      expect(results).toEqual(ids);
    });
  });

  describe('sequential requests', () => {
    test('a later request sees nothing from an earlier one', async () => {
      await RequestStore.run({}, async () => {
        RequestStore.setSourceApplicationEnvironmentId('env-first');
        RequestStore.setDeprecation({ deprecated_at: '2026-01-01T00:00:00Z' });
      });

      // No cleanup in between — isolation must not depend on it.
      const seen = await RequestStore.run({}, async () => ({
        env: RequestStore.getSourceApplicationEnvironmentId(),
        deprecation: RequestStore.getDeprecation(),
      }));

      expect(seen.env).toBeNull();
      expect(seen.deprecation).toBeNull();
    });

    test('a value set in a request is not visible after it ends', async () => {
      await RequestStore.run({}, async () => {
        RequestStore.setDeprecation({ deprecated_at: '2026-01-01T00:00:00Z' });
      });

      expect(RequestStore.getDeprecation()).toBeNull();
      expect(RequestStore.getSourceApplicationEnvironmentId()).toBeNull();
    });
  });

  describe('nested and detached contexts', () => {
    test('an inner request shadows rather than corrupts the outer one', async () => {
      await RequestStore.run({ id: 'outer' }, async () => {
        RequestStore.setDeprecation({ deprecated_at: 'outer-at' });

        await RequestStore.run({ id: 'inner' }, async () => {
          RequestStore.setDeprecation({ deprecated_at: 'inner-at' });
          expect(RequestStore.getDeprecation().deprecated_at).toBe('inner-at');
        });

        // The outer request is untouched by what the inner one did.
        expect(RequestStore.getDeprecation().deprecated_at).toBe('outer-at');
      });
    });

    test('setting outside a request is a no-op rather than an error', () => {
      expect(() => RequestStore.setDeprecation({ deprecated_at: 'x' })).not.toThrow();
      expect(() => RequestStore.setSourceApplicationEnvironmentId('x')).not.toThrow();

      expect(RequestStore.getDeprecation()).toBeNull();
      expect(RequestStore.getSourceApplicationEnvironmentId()).toBeNull();
    });
  });
});
