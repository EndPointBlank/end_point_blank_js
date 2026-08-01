'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { DirectWriter } = require('../../src/writers/direct-writer');

describe('DirectWriter', () => {
  beforeEach(() => {
    config._reset();
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

  describe('routing', () => {
    test.each([
      ['applicationErrorsUrl', 'https://log.epb.test/api/application_errors'],
      ['endpointErrorUrl', 'https://epb.test/api/endpoint_errors'],
      ['logUrl', 'https://log.epb.test/api/application_logs'],
      ['requestsUrl', 'https://log.epb.test/api/application_requests'],
      ['responsesUrl', 'https://log.epb.test/api/application_responses'],
    ])('sends %s payloads to %s', async (urlKey, expected) => {
      await new DirectWriter(urlKey).write([{ a: 1 }]);

      expect(post.mock.calls[0][0]).toBe(expected);
    });

    test('falls back to the application errors endpoint for an unknown key', async () => {
      // Better to file a record under the wrong heading than to throw inside
      // the caller's request path over a typo'd key.
      await new DirectWriter('nonsense').write([{ a: 1 }]);

      expect(post.mock.calls[0][0]).toBe('https://log.epb.test/api/application_errors');
    });

    test('resolves the URL from the configuration in force at construction time', async () => {
      config.logBaseUrl = 'https://other.epb.test';

      await new DirectWriter('logUrl').write([{ a: 1 }]);

      expect(post.mock.calls[0][0]).toBe('https://other.epb.test/api/application_logs');
    });
  });

  describe('the request it sends', () => {
    test('wraps the batch in a payload envelope', async () => {
      await new DirectWriter('logUrl').write([{ a: 1 }, { a: 2 }]);

      expect(post.mock.calls[0][2]).toEqual({ payload: [{ a: 1 }, { a: 2 }] });
    });

    test('authenticates with the configured client credentials', async () => {
      await new DirectWriter('logUrl').write([{ a: 1 }]);

      expect(post.mock.calls[0][1]).toMatch(/^Basic /);
    });
  });

  describe('when the write does not land', () => {
    test('warns rather than throwing on a rejected batch', async () => {
      // Telemetry is fire-and-forget: a rejected batch must never surface as
      // an exception in the application that produced it.
      post.mockResolvedValue({ status: 422, ok: false });

      await expect(new DirectWriter('logUrl').write([{ a: 1 }])).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });

    test('says nothing when the service is unreachable', async () => {
      // `post` already retried and logged; a second warning here would just
      // double the noise of an outage.
      post.mockResolvedValue(null);

      await expect(new DirectWriter('logUrl').write([{ a: 1 }])).resolves.toBeUndefined();
      expect(console.warn).not.toHaveBeenCalled();
    });

    test('stays quiet on success', async () => {
      await new DirectWriter('logUrl').write([{ a: 1 }]);

      expect(console.warn).not.toHaveBeenCalled();
    });
  });
});
