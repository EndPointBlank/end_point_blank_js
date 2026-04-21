'use strict';

const { RequestStore } = require('../src/request-store');

test('get() returns undefined outside a run context', () => {
  expect(RequestStore.get()).toBeUndefined();
});

test('get() returns the stored request inside run()', async () => {
  const mockReq = { url: '/test', method: 'GET' };
  let captured;

  await RequestStore.run(mockReq, async () => {
    captured = RequestStore.get();
  });

  expect(captured).toBe(mockReq);
});

test('get() returns undefined after run() completes', async () => {
  const mockReq = { url: '/test' };
  await RequestStore.run(mockReq, async () => {});
  expect(RequestStore.get()).toBeUndefined();
});

test('nested run() contexts are isolated', async () => {
  const outer = { url: '/outer' };
  const inner = { url: '/inner' };
  const captured = {};

  await RequestStore.run(outer, async () => {
    captured.outerBefore = RequestStore.get();

    await RequestStore.run(inner, async () => {
      captured.inner = RequestStore.get();
    });

    captured.outerAfter = RequestStore.get();
  });

  expect(captured.outerBefore).toBe(outer);
  expect(captured.inner).toBe(inner);
  expect(captured.outerAfter).toBe(outer);
});

test('concurrent run() contexts do not bleed into each other', async () => {
  const reqA = { url: '/a' };
  const reqB = { url: '/b' };
  const results = {};

  await Promise.all([
    RequestStore.run(reqA, async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.a = RequestStore.get();
    }),
    RequestStore.run(reqB, async () => {
      await new Promise((r) => setTimeout(r, 5));
      results.b = RequestStore.get();
    }),
  ]);

  expect(results.a).toBe(reqA);
  expect(results.b).toBe(reqB);
});
