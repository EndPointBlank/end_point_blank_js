'use strict';

/**
 * Masking on the `PayloadBuilder` / `Writer` path (sc-355).
 *
 * `RequestWriter`, `ResponseWriter` and `ExceptionWriter` each mask their own
 * payload, and each has a masking test beside it. This path had neither: an
 * integrator who configured `maskingRules` and reported an error through the
 * exported builder — or through the exported `Writer` factory — got no masking
 * at all, silently. `FIELD_MAP.error` maps `error_message` to the wire key
 * `message`, which is the one caller-supplied field this payload still carries
 * since sc-341 dropped `request` and `request_headers`.
 *
 * These assert on what was **posted**, the way
 * `tests/writers/request-writer.test.js`'s masking block does. The point of
 * masking is that the sensitive value never reaches the network, so asserting
 * on the object in between proves nothing about that.
 *
 * They live in their own file rather than in `tests/payload-builder.test.js` or
 * `tests/writers/writer.test.js` because those two describe the *shape* of the
 * record; this describes what is allowed to leave the process.
 */

jest.mock('../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../src/commands/_http');
const { instance: config, LogMode } = require('../src/configuration');
const { PayloadBuilder } = require('../src/payload-builder');
const { Writer } = require('../src/writers/writer');
const { DirectWriter } = require('../src/writers/direct-writer');

describe('masking the error payload built by PayloadBuilder', () => {
  const sentPayload = () => post.mock.calls[0][2].payload[0];
  const sentBody = () => JSON.stringify(post.mock.calls[0][2]);

  // A rule that is deliberately NOT idempotent: its replacement re-matches its
  // own regex, so applying it twice is visible in the output rather than
  // invisible. Once: "order [42] failed". Twice: "order [[42]] failed".
  const wrappingRule = { target: 'error_message', regex: '\\d+', replacement_value: '[$0]' };

  const redactSsn = {
    target: 'error_message',
    regex: '\\d{3}-\\d{2}-\\d{4}',
    replacement_value: '[redacted]',
  };

  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.environment = 'staging';
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.baseUrl = 'https://epb.test';
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  describe('through the Writer factory', () => {
    test('the sensitive value is not in the request body that was posted', async () => {
      config.maskingRules = [redactSsn];

      await new Writer('applicationErrorsUrl').write({
        message: 'lookup failed for 123-45-6789',
      });

      expect(sentBody()).not.toContain('123-45-6789');
      expect(sentPayload().message).toBe('lookup failed for [redacted]');
    });

    test('the rules are applied exactly once', async () => {
      // Masking is not idempotent in general — a replacement can re-match its
      // own regex. So this path must apply the rules once and once only, which
      // is why the call lives at the single point both routes share rather
      // than at each of them.
      config.maskingRules = [wrappingRule];

      await new Writer('applicationErrorsUrl').write({ message: 'order 42 failed' });

      expect(sentPayload().message).toBe('order [42] failed');
    });

    test('the mask hook runs exactly once', async () => {
      const seen = [];
      config.maskHook = (payload, recordType) => {
        seen.push(recordType);
        return { ...payload, message: `${recordType}:${payload.message}` };
      };

      await new Writer('applicationErrorsUrl').write({ message: 'boom' });

      expect(seen).toEqual(['error']);
      expect(sentPayload().message).toBe('error:boom');
    });

    test('the record is masked before it is queued in delayed mode', async () => {
      // Delayed mode defers the send, not the masking: an unmasked payload
      // must never sit in the in-memory queue either.
      config.logMode = LogMode.DELAYED;
      config.maskingRules = [redactSsn];

      await new Writer('applicationErrorsUrl').write({
        message: 'lookup failed for 123-45-6789',
      });
      await new Promise(resolve => setImmediate(resolve));

      expect(sentBody()).not.toContain('123-45-6789');
    });

    test('the fields no rule targets are sent untouched', async () => {
      config.maskingRules = [redactSsn];

      await new Writer('applicationErrorsUrl').write({
        message: 'lookup failed for 123-45-6789',
        stacktrace: ['at handcrafted (a.js:1:1)'],
        uuid: 'req-abc',
        path: '/v1/students',
        action: 'GET',
      });

      expect(sentPayload()).toMatchObject({
        app_name: 'billing',
        uuid: 'req-abc',
        stacktrace: ['at handcrafted (a.js:1:1)'],
        stamped_path: '/v1/students',
        stamped_http_method: 'GET',
      });
    });

    test('a rule aimed at another record type is left alone', async () => {
      // `FIELD_MAP.error` has one entry. A `request_body` rule has no wire key
      // on an error row, and must not be applied to `message` by accident.
      config.maskingRules = [
        { target: 'request_body', regex: '\\d+', replacement_value: 'X' },
      ];

      await new Writer('applicationErrorsUrl').write({ message: 'order 42 failed' });

      expect(sentPayload().message).toBe('order 42 failed');
    });
  });

  describe('through the builder used on its own', () => {
    test('the payload it hands back is already masked', async () => {
      // The builder is public API (`package.json` exports `./src/*`) and its
      // own docs offer it as the way to build an error row without going
      // through `ExceptionWriter`. A caller who takes it up on that and posts
      // the result themselves gets the configured masking.
      config.maskingRules = [redactSsn];

      await new DirectWriter('applicationErrorsUrl').write([
        PayloadBuilder.build({ message: 'lookup failed for 123-45-6789' }),
      ]);

      expect(sentBody()).not.toContain('123-45-6789');
      expect(sentPayload().message).toBe('lookup failed for [redacted]');
    });

    test('building twice does not mask twice', async () => {
      // Building is not a mutation of some shared record: two builds of the
      // same message produce the same masked message, not a doubly-masked one.
      config.maskingRules = [wrappingRule];

      const first = PayloadBuilder.build({ message: 'order 42 failed' });
      const second = PayloadBuilder.build({ message: 'order 42 failed' });

      expect(first.message).toBe('order [42] failed');
      expect(second.message).toBe('order [42] failed');
    });

    test('an unconfigured build is untouched, and cheap', () => {
      // The default is no rules and no hook, and that must stay a no-op —
      // every other test of this builder relies on it.
      const payload = PayloadBuilder.build({ message: 'order 42 failed' });

      expect(payload.message).toBe('order 42 failed');
    });
  });
});
