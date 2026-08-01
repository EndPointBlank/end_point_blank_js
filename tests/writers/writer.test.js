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
    await new Writer('endpointErrorUrl').write({ message: 'boom', status: 500 });

    expect(post.mock.calls[0][0]).toBe('https://epb.test/api/endpoint_errors');
  });

  test('reports the message, status and route it was given', async () => {
    await new Writer('endpointErrorUrl').write({
      message: 'boom',
      status: 500,
      path: '/v1/students',
      action: 'GET',
      version: '2',
    });

    expect(sentPayload()).toMatchObject({
      message: 'boom',
      status: 500,
      path: '/v1/students',
      action: 'GET',
      endpoint_version: '2',
    });
  });

  test('turns an error into a frame-by-frame stacktrace', async () => {
    await new Writer('endpointErrorUrl').write({ message: 'boom', status: 500, error: new Error('boom') });

    expect(Array.isArray(sentPayload().stacktrace)).toBe(true);
  });

  test('includes the URL of the request being served', async () => {
    const req = { protocol: 'https', headers: { host: 'api.example.test' }, originalUrl: '/v1/students' };

    await RequestStore.run(req, () =>
      new Writer('endpointErrorUrl').write({ message: 'boom', status: 500 }),
    );

    expect(sentPayload().url).toBe('https://api.example.test/v1/students');
  });

  test('keeps one underlying writer instead of building a new one per record', async () => {
    // A `DelayedWriter` owns the pending queue. Rebuilding it on every write
    // would strand queued records in a writer nobody holds a reference to.
    config.logMode = LogMode.DELAYED;
    const writer = new Writer('endpointErrorUrl');

    await writer.write({ message: 'one', status: 500 });
    await writer.write({ message: 'two', status: 500 });
    await new Promise(resolve => setImmediate(resolve));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][2].payload).toHaveLength(2);
  });

  test('waits for the send in direct mode', async () => {
    await new Writer('endpointErrorUrl').write({ message: 'boom', status: 500 });

    expect(post).toHaveBeenCalledTimes(1);
  });
});
