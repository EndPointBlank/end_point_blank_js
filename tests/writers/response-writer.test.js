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
});
