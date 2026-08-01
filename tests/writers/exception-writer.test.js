'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config, LogMode } = require('../../src/configuration');
const { RequestStore } = require('../../src/request-store');
const { ExceptionWriter } = require('../../src/writers/exception-writer');

describe('ExceptionWriter.write', () => {
  const sentPayload = () => post.mock.calls[0][2].payload[0];

  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.logBaseUrl = 'https://log.epb.test';
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  describe('the report it sends', () => {
    test('goes to the application errors endpoint', async () => {
      await ExceptionWriter.write(new Error('boom'));

      expect(post.mock.calls[0][0]).toBe('https://log.epb.test/api/application_errors');
    });

    test('carries the message and the configured application', async () => {
      await ExceptionWriter.write(new Error('payment gateway timed out'));

      expect(sentPayload()).toMatchObject({
        message: 'payment gateway timed out',
        app_name: 'billing',
      });
    });

    test('sends the stacktrace as an array of frames, never one blob of text', async () => {
      // Intake stores traces per frame; a single string arrives as a one-frame
      // trace that nobody can read or group on.
      await ExceptionWriter.write(new Error('boom'));

      const { stacktrace } = sentPayload();
      expect(Array.isArray(stacktrace)).toBe(true);
      expect(stacktrace[0]).toMatch(/^at /);
    });

    test('omits the message line from the trace, since it is already the message', async () => {
      await ExceptionWriter.write(new Error('boom'));

      expect(sentPayload().stacktrace.join('\n')).not.toContain('Error: boom');
    });

    test('sends a null trace for an error carrying no stack', async () => {
      const err = new Error('boom');
      delete err.stack;

      await ExceptionWriter.write(err);

      expect(sentPayload().stacktrace).toBeNull();
    });

    test('stamps the time as an ISO 8601 string', async () => {
      await ExceptionWriter.write(new Error('boom'));

      expect(sentPayload().sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    });
  });

  describe('when the error happened inside a request', () => {
    const req = { path: '/v1/checkout', method: 'POST', headers: {} };

    test('stamps the route being served', async () => {
      // An error without the route it came from is nearly impossible to triage.
      await RequestStore.run(req, () => ExceptionWriter.write(new Error('boom')));

      expect(sentPayload()).toMatchObject({
        stamped_path: '/v1/checkout',
        stamped_http_method: 'POST',
      });
    });

    test('correlates with the request being served', async () => {
      let expected;

      await RequestStore.run(req, async () => {
        expected = RequestStore.getUuid();
        await ExceptionWriter.write(new Error('boom'));
      });

      expect(sentPayload().uuid).toBe(expected);
    });

    test('includes the source application environment when one was resolved', async () => {
      await RequestStore.run(req, async () => {
        RequestStore.setSourceApplicationEnvironmentId('env-99');
        await ExceptionWriter.write(new Error('boom'));
      });

      expect(sentPayload().source_application_environment_id).toBe('env-99');
    });

    test('falls back to the full URL when the framework exposes no path', async () => {
      await RequestStore.run({ originalUrl: '/v1/checkout?x=1', method: 'POST' }, () =>
        ExceptionWriter.write(new Error('boom')),
      );

      expect(sentPayload().stamped_path).toBe('/v1/checkout?x=1');
    });
  });

  describe('when the error happened outside a request', () => {
    test('still reports it', async () => {
      // Startup failures and background-job crashes are exactly the ones you
      // most want to hear about.
      await ExceptionWriter.write(new Error('worker crashed'));

      expect(sentPayload().message).toBe('worker crashed');
    });

    test('leaves the request-scoped fields out rather than guessing', async () => {
      await ExceptionWriter.write(new Error('worker crashed'));

      expect(sentPayload()).not.toHaveProperty('stamped_path');
      expect(sentPayload().uuid).toBeNull();
    });
  });

  describe('masking', () => {
    test('redacts the message before it leaves the process', async () => {
      config.maskingRules = [
        { target: 'error_message', regex: '\\d{3}-\\d{2}-\\d{4}', replacement_value: '[redacted]' },
      ];

      await ExceptionWriter.write(new Error('rejected for 123-45-6789'));

      expect(sentPayload().message).toBe('rejected for [redacted]');
    });
  });

  describe('robustness', () => {
    test('never throws while reporting an error', async () => {
      // This runs from an error handler. Throwing here would replace the
      // customer's real error with one from the reporter.
      config.maskHook = () => {
        throw new Error('bad hook');
      };

      await expect(ExceptionWriter.write(new Error('boom'))).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });

    test('returns before sending in delayed mode', async () => {
      config.logMode = LogMode.DELAYED;

      await ExceptionWriter.write(new Error('boom'));

      expect(post).not.toHaveBeenCalled();

      await new Promise(resolve => setImmediate(resolve));
      expect(post).toHaveBeenCalledTimes(1);
    });
  });
});
