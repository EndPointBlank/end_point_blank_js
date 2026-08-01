'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config, LogMode } = require('../../src/configuration');
const { RequestStore } = require('../../src/request-store');
const { RequestWriter } = require('../../src/writers/request-writer');

describe('RequestWriter.write', () => {
  const sentPayload = () => post.mock.calls[0][2].payload[0];

  const req = (overrides = {}) => ({
    headers: { 'content-type': 'application/json', ...overrides.headers },
    method: 'POST',
    path: '/v1/students',
    hostname: 'api.example.test',
    ...overrides,
  });

  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.environment = 'staging';
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

  describe('the record it sends', () => {
    test('goes to the requests ingest endpoint', async () => {
      await RequestWriter.write(req());

      expect(post.mock.calls[0][0]).toBe('https://log.epb.test/api/application_requests');
    });

    test('describes the call: app, environment, host, path and method', async () => {
      await RequestWriter.write(req());

      expect(sentPayload()).toMatchObject({
        app_name: 'billing',
        env: 'staging',
        host: 'api.example.test',
        path: '/v1/students',
        http_method: 'POST',
      });
    });

    test('records the detected endpoint version', async () => {
      await RequestWriter.write(req({ headers: { 'x-api-version': 'v3' } }));

      expect(sentPayload().endpoint_version).toBe('3');
    });

    test('copies the headers rather than sending the live object', async () => {
      // Masking rebuilds the map; sending the request's own headers object
      // would risk the SDK's redaction leaking back into the running request.
      const request = req();

      await RequestWriter.write(request);

      expect(sentPayload().headers).not.toBe(request.headers);
      expect(sentPayload().headers).toEqual(request.headers);
    });

    test('falls back to the URL when the framework exposes no path', async () => {
      const bare = { headers: {}, method: 'GET', url: '/v1/students?q=1' };

      await RequestWriter.write(bare);

      expect(sentPayload().path).toBe('/v1/students?q=1');
    });

    test('copes with a request that has no headers at all', async () => {
      await RequestWriter.write({ method: 'GET', url: '/x' });

      expect(sentPayload().headers).toEqual({});
    });

    test('falls back to the raw host for frameworks that do not resolve one', async () => {
      await RequestWriter.write({ headers: {}, method: 'GET', url: '/x', host: 'api.example.test' });

      expect(sentPayload().host).toBe('api.example.test');
    });

    test('sends nulls rather than guesses when the request says almost nothing', async () => {
      await RequestWriter.write({ headers: {} });

      expect(sentPayload().host).toBeNull();
      expect(sentPayload().path).toBeNull();
      expect(sentPayload().http_method).toBeNull();
    });
  });

  describe('the request body', () => {
    test('is serialised when a body parser has already parsed it', async () => {
      await RequestWriter.write(req({ body: { amount: 42 } }));

      expect(sentPayload().request).toBe('{"amount":42}');
    });

    test('is passed through untouched when it is raw text', async () => {
      await RequestWriter.write(req({ body: 'amount=42' }));

      expect(sentPayload().request).toBe('amount=42');
    });

    test('is null when no body parser ran', async () => {
      await RequestWriter.write(req());

      expect(sentPayload().request).toBeNull();
    });

    test('is null for an explicitly empty body', async () => {
      await RequestWriter.write(req({ body: null }));

      expect(sentPayload().request).toBeNull();
    });

    test('is null rather than an exception when it cannot be serialised', async () => {
      // Express bodies can hold circular references (streams, sockets). The
      // record should lose the body, not the whole request.
      const circular = { name: 'loop' };
      circular.self = circular;

      await RequestWriter.write(req({ body: circular }));

      expect(sentPayload().request).toBeNull();
    });
  });

  describe('correlating the record', () => {
    test('uses the SDK\'s own request id when one is in flight', async () => {
      let expected;

      await RequestStore.run(req(), async () => {
        expected = RequestStore.getUuid();
        await RequestWriter.write(req());
      });

      expect(sentPayload().uuid).toBe(expected);
    });

    test('adopts the caller\'s request id outside a tracked request', async () => {
      await RequestWriter.write(req({ headers: { 'x-request-id': 'req-abc' } }));

      expect(sentPayload().uuid).toBe('req-abc');
    });

    test('falls back to the framework request id', async () => {
      await RequestWriter.write(req({ id: 'express-1' }));

      expect(sentPayload().uuid).toBe('express-1');
    });

    test('sends null when nothing identifies the request', async () => {
      await RequestWriter.write(req());

      expect(sentPayload().uuid).toBeNull();
    });
  });

  describe('masking', () => {
    test('applies the configured rules before the record leaves the process', async () => {
      // The point of masking is that the sensitive value never reaches the
      // network, so this asserts on what was actually posted.
      config.maskingRules = [
        { target: 'request_headers', path: '$.authorization', replacement_value: '[redacted]' },
      ];

      await RequestWriter.write(req({ headers: { authorization: 'Basic c3VwZXItc2VjcmV0' } }));

      expect(sentPayload().headers.authorization).toBe('[redacted]');
    });
  });

  describe('robustness', () => {
    test('does nothing at all when there is no request', async () => {
      await RequestWriter.write(null);

      expect(post).not.toHaveBeenCalled();
    });

    test('never throws into the request it is reporting on', async () => {
      // `versionFinder` is customer-supplied code running on every request.
      config.versionFinder = () => {
        throw new Error('bad version finder');
      };

      await expect(RequestWriter.write(req())).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });

    test('returns before sending in delayed mode', async () => {
      config.logMode = LogMode.DELAYED;

      await RequestWriter.write(req());

      expect(post).not.toHaveBeenCalled();

      await new Promise(resolve => setImmediate(resolve));
      expect(post).toHaveBeenCalledTimes(1);
    });
  });
});
