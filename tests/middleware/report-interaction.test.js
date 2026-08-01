'use strict';

// These tests drive the real middleware, so they must stub the one thing that
// leaves the process. Mocking `_http` catches every writer at once —
// RequestWriter and ExceptionWriter both funnel through `post` — and lets the
// assertions name the URL and payload, which is what makes them able to fail.
//
// The earlier version of this file spied on `Writer.prototype.write`. Nothing
// in this code path constructs a `Writer`: ExceptionWriter builds a
// DirectWriter directly. So the spy recorded nothing no matter what happened,
// the "does not log UnauthorizedError" assertion could not fail, and the real
// calls went out to production intake.
jest.mock('../../src/commands/_http', () => ({
  post: jest.fn().mockResolvedValue({ status: 201, ok: true }),
}));

const { post } = require('../../src/commands/_http');
const { instance: config } = require('../../src/configuration');
const { reportInteraction, reportInteractionErrorHandler } = require('../../src/middleware/report-interaction');
const { RequestStore } = require('../../src/request-store');
const { UnauthorizedError } = require('../../src/unauthorized-error');

function makeReq(overrides = {}) {
  return {
    headers: { accept: 'application/vnd.api.v1+json', host: 'localhost' },
    method: 'GET',
    url: '/api/v1/test',
    path: '/api/v1/test',
    originalUrl: '/api/v1/test',
    ...overrides,
  };
}

function makeRes() {
  // Minimal Express-like response: reportInteraction registers a
  // `res.on('finish', ...)` handler and reads statusCode/getHeaders there.
  return {
    statusCode: 200,
    on: () => {},
    getHeaders: () => ({}),
  };
}

/** Lets the middleware's unawaited fire-and-forget writes settle. */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** The payloads POSTed to `url`, unwrapped from the `{ payload: [...] }` envelope. */
function payloadsSentTo(url) {
  return post.mock.calls
    .filter(([sentUrl]) => sentUrl === url)
    .flatMap(([, , body]) => body.payload);
}

beforeEach(() => {
  post.mockClear();
});

describe('reportInteraction', () => {
  test('stores the request in RequestStore for the duration of the chain', async () => {
    const req = makeReq();
    let captured;

    await new Promise(resolve => {
      reportInteraction(req, makeRes(), () => {
        captured = RequestStore.get();
        resolve();
      });
    });

    expect(captured).toBe(req);
    await flush();
  });

  test('calls next() to pass control down the chain', async () => {
    const next = jest.fn();

    await new Promise(resolve => {
      reportInteraction(makeReq(), makeRes(), () => {
        next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalled();
    await flush();
  });

  test('reports the request to the requests endpoint', async () => {
    reportInteraction(makeReq({ method: 'POST' }), makeRes(), () => {});
    await flush();

    const [payload] = payloadsSentTo(config.requestsUrl);

    expect(payload).toMatchObject({
      path: '/api/v1/test',
      http_method: 'POST',
    });
  });
});

describe('reportInteractionErrorHandler', () => {
  test('reports the error to the application errors endpoint', async () => {
    const next = jest.fn();

    await reportInteractionErrorHandler(new Error('Something broke'), makeReq(), makeRes(), next);

    const [payload] = payloadsSentTo(config.applicationErrorsUrl);

    expect(payload).toMatchObject({ message: 'Something broke' });
    expect(next).toHaveBeenCalled();
  });

  test('does not report an UnauthorizedError', async () => {
    // A rejected caller is expected behaviour, not an application fault. If
    // these were reported, a bot probing endpoints would flood the error log.
    const err = new UnauthorizedError('Not allowed');
    const next = jest.fn();

    await reportInteractionErrorHandler(err, makeReq(), makeRes(), next);

    expect(payloadsSentTo(config.applicationErrorsUrl)).toEqual([]);
    expect(next).toHaveBeenCalledWith(err);
  });

  test('passes the error down the chain either way', async () => {
    // Swallowing it here would turn a 500 into a hung request.
    const err = new Error('Something broke');
    const next = jest.fn();

    await reportInteractionErrorHandler(err, makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(err);
  });
});
