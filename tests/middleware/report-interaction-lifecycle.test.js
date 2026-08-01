'use strict';

jest.mock('../../src/commands/_http', () => ({ post: jest.fn() }));

const { EventEmitter } = require('events');
const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { RequestStore } = require('../../src/request-store');
const { UnauthorizedError } = require('../../src/unauthorized-error');
const {
  reportInteraction,
  reportInteractionErrorHandler,
} = require('../../src/middleware/report-interaction');

/**
 * The interaction middleware is the one piece that runs on every single
 * request, so what matters is that it reports faithfully and that nothing it
 * does can take the request down with it.
 */
describe('reportInteraction', () => {
  const makeReq = (overrides = {}) => ({
    headers: { host: 'api.example.test' },
    method: 'GET',
    path: '/v1/students',
    url: '/v1/students',
    ...overrides,
  });

  // A response that behaves like Node's: `end()` completes the response and
  // `finish` follows on a later tick, from inside the handler's async chain.
  const makeRes = ({ withHeaders = true } = {}) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    if (withHeaders) res.getHeaders = () => ({ 'content-type': 'application/json' });
    res.end = () => setImmediate(() => res.emit('finish'));
    return res;
  };

  // Records posted so far, unwrapped from their batch envelopes and tagged
  // with the endpoint they went to.
  const recordsTo = fragment =>
    post.mock.calls.filter(([url]) => url.includes(fragment)).flatMap(([, , body]) => body.payload);

  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  };

  // Runs the middleware the way Express does: the route handler runs inside it
  // and ends the response, which is what makes `finish` fire.
  const serve = async (req, res) => {
    reportInteraction(req, res, () => res.end());
    await settle();
  };

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

  describe('the request record', () => {
    test('is written for the request being served', async () => {
      reportInteraction(makeReq(), makeRes(), () => {});
      await settle();

      expect(recordsTo('application_requests')[0]).toMatchObject({
        path: '/v1/students',
        http_method: 'GET',
      });
    });

    test('does not delay the route handler', async () => {
      // The write is deliberately not awaited: the customer's handler must not
      // wait on a telemetry POST before it starts.
      const next = jest.fn();

      reportInteraction(makeReq(), makeRes(), next);

      expect(next).toHaveBeenCalled();
      await settle();
    });

    test('does not break the request when it cannot be written', async () => {
      post.mockRejectedValue(new Error('connection reset'));
      const next = jest.fn();

      expect(() => reportInteraction(makeReq(), makeRes(), next)).not.toThrow();
      await settle();

      expect(next).toHaveBeenCalled();
    });
  });

  describe('the response record', () => {
    test('is not written until the response has actually finished', async () => {
      // Written any earlier and the status would be whatever it happened to be
      // mid-flight rather than what the client received.
      reportInteraction(makeReq(), makeRes(), () => {});
      await settle();

      expect(recordsTo('application_responses')).toHaveLength(0);
    });

    test('reports the status the client actually received', async () => {
      const res = makeRes();
      res.statusCode = 404;

      await serve(makeReq(), res);

      expect(recordsTo('application_responses')[0].status).toBe(404);
    });

    test('reports the headers that went out', async () => {
      await serve(makeReq(), makeRes());

      expect(recordsTo('application_responses')[0].headers).toEqual({
        'content-type': 'application/json',
      });
    });

    test('correlates with the request that produced it', async () => {
      // The `finish` listener fires after the middleware has returned, on a
      // later tick. It still has to land in the same request context, or the
      // request and response records cannot be joined up in the portal.
      await serve(makeReq(), makeRes());

      const [request] = recordsTo('application_requests');
      const [response] = recordsTo('application_responses');
      expect(response.uuid).toBe(request.uuid);
      expect(response.uuid).toBeTruthy();
    });

    test('records the route pattern rather than the concrete URL', async () => {
      await serve(makeReq({ route: { path: '/v1/students/:id' } }), makeRes());

      expect(recordsTo('application_responses')[0].route).toBe('/v1/students/:id');
    });

    test('copes with a response object that exposes no headers', async () => {
      await serve(makeReq(), makeRes({ withHeaders: false }));

      expect(recordsTo('application_responses')[0].headers).toEqual({});
    });

    test('does not break the response when it cannot be written', async () => {
      post.mockRejectedValue(new Error('connection reset'));
      const res = makeRes();

      await expect(serve(makeReq(), res)).resolves.toBeUndefined();
    });
  });

  test('makes the request available to everything downstream', async () => {
    const req = makeReq();
    let seen;

    reportInteraction(req, makeRes(), () => {
      seen = RequestStore.get();
    });
    await settle();

    expect(seen).toBe(req);
  });
});

describe('reportInteractionErrorHandler', () => {
  const req = { headers: {}, method: 'GET', path: '/v1/students' };

  const errorRecords = () =>
    post.mock.calls
      .filter(([url]) => url.includes('application_errors'))
      .flatMap(([, , body]) => body.payload);

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

  test('reports an unexpected error', async () => {
    await reportInteractionErrorHandler(new Error('database is on fire'), req, {}, jest.fn());

    expect(errorRecords()[0].message).toBe('database is on fire');
  });

  test('stays silent about a rejected request', async () => {
    // Unauthorized access attempts are expected traffic, not incidents. Filing
    // them as application errors would bury the real ones.
    await reportInteractionErrorHandler(new UnauthorizedError('nope'), req, {}, jest.fn());

    expect(errorRecords()).toHaveLength(0);
  });

  test('passes every error on to the app\'s own handler', async () => {
    const err = new Error('database is on fire');
    const next = jest.fn();

    await reportInteractionErrorHandler(err, req, {}, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  test('passes a rejection on as well, so the app still answers 401', async () => {
    const err = new UnauthorizedError('nope');
    const next = jest.fn();

    await reportInteractionErrorHandler(err, req, {}, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  test('still hands the error on when reporting it fails', async () => {
    // The customer's error must reach their handler even if EndPointBlank is
    // down — otherwise an outage here turns their 500 into a hung request.
    post.mockRejectedValue(new Error('connection reset'));
    const err = new Error('database is on fire');
    const next = jest.fn();

    await reportInteractionErrorHandler(err, req, {}, next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
