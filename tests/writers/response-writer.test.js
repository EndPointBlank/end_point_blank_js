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

  describe('correlating the record', () => {
    test('sends the id the SDK minted for the request being served', async () => {
      let expected;

      await RequestStore.run({ method: 'GET', headers: {} }, async () => {
        expected = RequestStore.getUuid();
        await ResponseWriter.write(200, {}, null, {});
      });

      expect(sentPayload().uuid).toBe(expected);
    });

    test('sends null outside a request rather than minting one', async () => {
      // Deliberately unlike `ExceptionWriter` and `RequestWriter`, which sc-353
      // changed to mint here. Those two stream to tables that require `uuid`,
      // so a null is a refused row and a fresh id is the difference between
      // recording the event and recording nothing. `application_responses`
      // requires only `[:status, :target_application_environment_id]`
      // (`intake/lib/intake/interactions/application_response.ex:44`), so this
      // row is stored either way — and a minted id would join to nothing, the
      // same as null, while reading like a correlation that exists.
      await ResponseWriter.write(200, {}, null, {});

      expect(sentPayload().uuid).toBeNull();
    });

    test('ignores an inbound request id, which only the store can supply', async () => {
      // The writer used to fall back to `x-request-id` and `req.id` off the
      // stored request. Both were unreachable: `req` comes from
      // `RequestStore.get()`, which is non-empty only inside
      // `RequestStore.run`, and `run` always mints a uuid — so `getUuid()` was
      // truthy whenever those terms had a request to read. They are gone, and
      // this pins that removal: a real request carrying a header the SDK is not
      // tracking still correlates on the minted id, never on the header.
      let expected;
      const req = { method: 'GET', id: 'express-1', headers: { 'x-request-id': 'req-abc' } };

      await RequestStore.run(req, async () => {
        expected = RequestStore.getUuid();
        await ResponseWriter.write(200, {}, null, {});
      });

      expect(sentPayload().uuid).toBe(expected);
      expect(sentPayload().uuid).not.toBe('req-abc');
    });
  });

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
