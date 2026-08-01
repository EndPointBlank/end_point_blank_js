'use strict';

const { ResponseWriter } = require('../../src/writers/response-writer');
const { RequestStore } = require('../../src/request-store');
const { DirectWriter } = require('../../src/writers/direct-writer');

describe('ResponseWriter', () => {
  let writeSpy;

  beforeEach(() => {
    writeSpy = jest.spyOn(DirectWriter.prototype, 'write').mockResolvedValue();
  });

  afterEach(() => {
    writeSpy.mockRestore();
    jest.restoreAllMocks();
  });

  test('includes the route and HTTP method from the stored request', async () => {
    const req = { method: 'GET', route: { path: '/users/:id' }, headers: {} };
    jest.spyOn(RequestStore, 'get').mockReturnValue(req);

    await ResponseWriter.write(200, {}, null, {});

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [payloads] = writeSpy.mock.calls[0];
    expect(payloads[0].route).toBe('/users/:id');
    expect(payloads[0].method).toBe('GET');
  });

  test('sends null route and null method when there is no stored request', async () => {
    jest.spyOn(RequestStore, 'get').mockReturnValue(undefined);

    await ResponseWriter.write(200, {}, null, {});

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [payloads] = writeSpy.mock.calls[0];
    expect(payloads[0].route).toBeNull();
    expect(payloads[0].method).toBeNull();
  });

  const sentPayload = () => writeSpy.mock.calls[0][0][0];

  describe('the response body', () => {
    test('is recorded as-is when it is small', async () => {
      await ResponseWriter.write(200, {}, '{"ok":true}');

      expect(sentPayload().body).toBe('{"ok":true}');
    });

    test('is cut down when it is large', async () => {
      // A response record is telemetry, not an archive; a multi-megabyte body
      // would be rejected on ingest and costs the customer bandwidth to send.
      await ResponseWriter.write(200, {}, 'x'.repeat(5000));

      expect(sentPayload().body.length).toBeLessThan(5000);
      expect(sentPayload().body.endsWith('...')).toBe(true);
    });

    test('is null when there was no body', async () => {
      await ResponseWriter.write(204, {});

      expect(sentPayload().body).toBeNull();
    });
  });

  test('records an empty headers map and empty data when none were given', async () => {
    await ResponseWriter.write(204);

    expect(sentPayload().headers).toEqual({});
    expect(sentPayload().data).toEqual({});
  });

  test('returns before sending in delayed mode', async () => {
    // Consistent with the other writers: the `finish` handler must not hold a
    // socket open waiting on a telemetry POST.
    const { instance: config, LogMode } = require('../../src/configuration');
    config.logMode = LogMode.DELAYED;

    await ResponseWriter.write(200, {}, null);

    expect(writeSpy).not.toHaveBeenCalled();

    await new Promise(resolve => setImmediate(resolve));
    expect(writeSpy).toHaveBeenCalledTimes(1);

    config._reset();
  });

  test('never throws into the response path', async () => {
    // This runs from the `finish` listener of a response that has already been
    // sent. Throwing here surfaces as an unhandled rejection, not a 500.
    const { instance: config } = require('../../src/configuration');
    config.maskHook = () => {
      throw new Error('bad hook');
    };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ResponseWriter.write(200, {}, null)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    config.maskHook = null;
  });
});
