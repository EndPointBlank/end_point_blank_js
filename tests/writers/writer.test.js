'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config, LogMode } = require('../../src/configuration');
const { RequestStore } = require('../../src/request-store');
const { Writer } = require('../../src/writers/writer');

describe('Writer', () => {
  const sentPayload = () => post.mock.calls[0][2].payload[0];

  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.environment = 'staging';
    config.clientId = 'client-id';
    config.clientSecret = 'client-secret';
    config.baseUrl = 'https://epb.test';
    config.logBaseUrl = 'https://log.epb.test';
    post.mockReset();
    post.mockResolvedValue({ status: 201, ok: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config._reset();
  });

  test('sends a built payload to the endpoint named by its URL key', async () => {
    // The URL key is the caller's choice, not this class's: `Writer` forwards
    // whatever key it was handed to the underlying writer. `logUrl` resolves
    // off `logBaseUrl`, so a wrong key would be visible in the host as well as
    // the path.
    await new Writer('logUrl').write({ message: 'boom' });

    expect(post.mock.calls[0][0]).toBe('https://log.epb.test/api/application_logs');
  });

  test('reports the message and the route it was given', async () => {
    await new Writer('applicationErrorsUrl').write({
      message: 'boom',
      path: '/v1/students',
      action: 'GET',
    });

    expect(sentPayload()).toMatchObject({
      message: 'boom',
      stamped_path: '/v1/students',
      stamped_http_method: 'GET',
    });
  });

  test('turns an error into a frame-by-frame stacktrace', async () => {
    await new Writer('applicationErrorsUrl').write({ message: 'boom', error: new Error('boom') });

    expect(Array.isArray(sentPayload().stacktrace)).toBe(true);
  });

  test('forwards every option to the builder, including the ones it never listed', async () => {
    // This method used to relist the builder's options and destructure them
    // one by one, and `stacktrace` was not among them: a caller-supplied trace
    // was accepted and thrown away. The list is gone; `opts` goes through whole.
    await new Writer('applicationErrorsUrl').write({
      message: 'boom',
      stacktrace: ['at handcrafted (a.js:1:1)'],
      uuid: 'req-abc',
    });

    expect(sentPayload()).toMatchObject({
      stacktrace: ['at handcrafted (a.js:1:1)'],
      uuid: 'req-abc',
    });
  });

  test('stamps the request being served', async () => {
    const req = { path: '/v1/students', method: 'GET' };

    await RequestStore.run(req, () =>
      new Writer('applicationErrorsUrl').write({ message: 'boom' }),
    );

    expect(sentPayload().stamped_path).toBe('/v1/students');
  });

  test('keeps one underlying writer instead of building a new one per record', async () => {
    // A `DelayedWriter` owns the pending queue. Rebuilding it on every write
    // would strand queued records in a writer nobody holds a reference to.
    config.logMode = LogMode.DELAYED;
    const writer = new Writer('applicationErrorsUrl');

    await writer.write({ message: 'one' });
    await writer.write({ message: 'two' });
    await new Promise(resolve => setImmediate(resolve));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][2].payload).toHaveLength(2);
  });

  test('waits for the send in direct mode', async () => {
    await new Writer('applicationErrorsUrl').write({ message: 'boom' });

    expect(post).toHaveBeenCalledTimes(1);
  });
});
