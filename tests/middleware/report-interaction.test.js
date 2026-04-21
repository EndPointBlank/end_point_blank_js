'use strict';

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
  return { status: 200 };
}

test('stores request in RequestStore during middleware execution', async () => {
  const req = makeReq();
  let captured;

  await new Promise((resolve) => {
    reportInteraction(req, makeRes(), () => {
      captured = RequestStore.get();
      resolve();
    });
  });

  expect(captured).toBe(req);
});

test('calls next() to pass control down the chain', async () => {
  const next = jest.fn();
  const req = makeReq();

  await new Promise((resolve) => {
    reportInteraction(req, makeRes(), () => {
      next();
      resolve();
    });
  });

  expect(next).toHaveBeenCalled();
});

test('error handler skips logging for UnauthorizedError', async () => {
  const err = new UnauthorizedError('Not allowed');
  const next = jest.fn();
  const req = makeReq();
  const res = makeRes();

  // Spy on writer to ensure it is NOT called
  const { Writer } = require('../../src/writers/writer');
  const writeSpy = jest.spyOn(Writer.prototype, 'write').mockResolvedValue();

  await reportInteractionErrorHandler(err, req, res, next);

  expect(writeSpy).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledWith(err);

  writeSpy.mockRestore();
});

test('error handler calls next(err) after reporting', async () => {
  const err = new Error('Something broke');
  const next = jest.fn();
  const req = makeReq();
  const res = makeRes();

  const { Writer } = require('../../src/writers/writer');
  const writeSpy = jest.spyOn(Writer.prototype, 'write').mockResolvedValue();

  await reportInteractionErrorHandler(err, req, res, next);

  expect(next).toHaveBeenCalledWith(err);
  writeSpy.mockRestore();
});
