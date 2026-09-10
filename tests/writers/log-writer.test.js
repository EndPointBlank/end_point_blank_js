'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config, LogMode } = require('../../src/configuration');
const { RequestStore } = require('../../src/request-store');
const { LogWriter } = require('../../src/writers/log-writer');

// Same matcher `ExceptionWriter`'s tests use for its minted-uuid fallback.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('LogWriter', () => {
  // The payload as it goes over the wire, unwrapped from the batch envelope.
  const sentPayload = () => post.mock.calls[0][2].payload[0];

  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  describe('levels', () => {
    test.each([
      ['info', 'info'],
      ['warn', 'warn'],
      ['error', 'error'],
      ['fatal', 'fatal'],
    ])('%s() records the entry at level %s', async (method, level) => {
      await LogWriter[method]('something happened');

      expect(sentPayload()).toMatchObject({ message: 'something happened', log_level: level });
    });
  });

  describe('the entry it sends', () => {
    test('carries the configured application name', async () => {
      await LogWriter.info('hello');

      expect(sentPayload().app_name).toBe('billing');
    });

    test('carries the caller\'s structured data', async () => {
      await LogWriter.info('payment processed', { amount: 42, currency: 'GBP' });

      expect(sentPayload().data).toEqual({ amount: 42, currency: 'GBP' });
    });

    test('sends an empty data object when the caller supplied none', async () => {
      await LogWriter.info('hello');

      expect(sentPayload().data).toEqual({});
    });

    test('stamps the time as an ISO 8601 string', async () => {
      await LogWriter.info('hello');

      expect(sentPayload().sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    });

    test('goes to the log ingest endpoint', async () => {
      config.logBaseUrl = 'https://log.epb.test';

      await LogWriter.info('hello');

      expect(post.mock.calls[0][0]).toBe('https://log.epb.test/api/application_logs');
    });
  });

  describe('when there is a request in flight', () => {
    const req = { path: '/v1/students', method: 'GET', headers: { 'x-request-id': 'req-abc' } };

    test('stamps the entry with the route being served', async () => {
      // Without the stamp a log line cannot be joined to the request that
      // produced it, which is most of the value of shipping logs at all.
      await RequestStore.run(req, () => LogWriter.info('hello'));

      expect(sentPayload()).toMatchObject({
        stamped_path: '/v1/students',
        stamped_http_method: 'GET',
      });
    });

    test('correlates with the request being served, not the caller\'s inbound id', async () => {
      // Same source as `RequestWriter`/`ResponseWriter`/`ExceptionWriter`, so
      // all four rows for one interaction join on the same uuid. `req` here
      // still carries an inbound `x-request-id` header on purpose: this test
      // proves the log row no longer adopts it, which is the sc-380 fix.
      let expected;

      await RequestStore.run(req, async () => {
        expected = RequestStore.getUuid();
        await LogWriter.info('hello');
      });

      expect(sentPayload().uuid).toBe(expected);
      expect(sentPayload().uuid).not.toBe('req-abc');
    });

    test('carries the same id a response for the same request would carry', async () => {
      // The whole point of the fix: a log row and a response row for the same
      // request must share a uuid so the portal can join them.
      let logUuid;
      let storeUuid;

      await RequestStore.run(req, async () => {
        await LogWriter.info('hello');
        logUuid = post.mock.calls[0][2].payload[0].uuid;
        storeUuid = RequestStore.getUuid();
      });

      expect(logUuid).toBe(storeUuid);
    });

    test('falls back to the full URL when the framework exposes no path', async () => {
      await RequestStore.run({ originalUrl: '/v1/students?q=1', method: 'GET' }, () =>
        LogWriter.info('hello'),
      );

      expect(sentPayload().stamped_path).toBe('/v1/students?q=1');
    });

    test('includes the source application environment when one was resolved', async () => {
      await RequestStore.run(req, async () => {
        RequestStore.setSourceApplicationEnvironmentId('env-99');
        await LogWriter.info('hello');
      });

      expect(sentPayload().source_application_environment_id).toBe('env-99');
    });
  });

  describe('when there is no request in flight', () => {
    test('still sends the entry', async () => {
      // Startup and background-job logging happen outside any request.
      await LogWriter.info('worker started');

      expect(sentPayload().message).toBe('worker started');
    });

    test('leaves the request-scoped stamps out rather than guessing', async () => {
      await LogWriter.info('worker started');

      expect(sentPayload()).not.toHaveProperty('stamped_path');
    });

    test('still carries a minted id, because a log call outside a request is exactly as possible as an exception one', async () => {
      // Same reasoning as `ExceptionWriter` under sc-353: `RequestStore.getUuid()`
      // answers null outside a request, and a null log row would be no more
      // correlated than a minted one -- it would just carry no id at all. See sc-380.
      await LogWriter.info('worker started');

      expect(sentPayload().uuid).toMatch(UUID_V4);
    });

    test('mints a fresh id per entry, so unrelated log lines do not look correlated', async () => {
      await LogWriter.info('first');
      await LogWriter.info('second');

      const [first, second] = post.mock.calls.map(call => call[2].payload[0].uuid);
      expect(first).not.toBe(second);
    });
  });

  describe('delivery mode', () => {
    test('waits for the send in direct mode', async () => {
      await LogWriter.info('hello');

      expect(post).toHaveBeenCalledTimes(1);
    });

    test('returns before sending in delayed mode', async () => {
      // Delayed mode exists so logging never adds latency to a request.
      config.logMode = LogMode.DELAYED;

      await LogWriter.info('hello');

      expect(post).not.toHaveBeenCalled();

      await new Promise(resolve => setImmediate(resolve));
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  test('never throws into the caller when the send fails', async () => {
    // A logging call is not worth taking down the code that made it.
    post.mockRejectedValue(new Error('connection reset'));

    await expect(LogWriter.info('hello')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
