'use strict';

const { PayloadBuilder } = require('../src/payload-builder');
const { RequestStore } = require('../src/request-store');
const { instance: config } = require('../src/configuration');

describe('PayloadBuilder.build', () => {
  beforeEach(() => {
    config._reset();
    config.appName = 'billing';
    config.environment = 'staging';
  });

  afterEach(() => config._reset());

  const build = (opts, req) =>
    req
      ? RequestStore.run(req, () => PayloadBuilder.build(opts))
      : PayloadBuilder.build(opts);

  describe('the fields it always sends', () => {
    test('carries the message, status and configured application', () => {
      const payload = build({ message: 'boom', status: 500 });

      expect(payload).toMatchObject({ message: 'boom', status: 500, app_name: 'billing' });
    });

    test('stamps the environment it is running in', () => {
      expect(build({ message: 'boom', status: 500 }).env).toBe('staging');
    });

    test('stamps the time as an ISO 8601 string', () => {
      const payload = build({ message: 'boom', status: 500, sentAt: new Date('2026-08-01T14:15:16Z') });

      expect(payload.sent_at).toBe('2026-08-01T14:15:16.000Z');
    });

    test('stamps the current time when none is supplied', () => {
      const before = Date.now();

      const stamped = Date.parse(build({ message: 'boom', status: 500 }).sent_at);

      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(Date.now());
    });

    test('names the endpoint version with a qualified key', () => {
      // The wire contract is `endpoint_version`; a bare `version` would be
      // dropped on ingest.
      const payload = build({ message: 'boom', status: 500, version: '2' });

      expect(payload.endpoint_version).toBe('2');
      expect(payload).not.toHaveProperty('version');
    });

    test('defaults the optional route details to null rather than omitting them', () => {
      const payload = build({ message: 'boom', status: 500 });

      expect(payload.path).toBeNull();
      expect(payload.action).toBeNull();
      expect(payload.endpoint_version).toBeNull();
    });

    test('defaults the request headers to an empty map', () => {
      expect(build({ message: 'boom', status: 500 }).request_headers).toEqual({});
    });
  });

  describe('the stacktrace', () => {
    test('is an array of frames, never one blob of text', () => {
      // Every SDK sends stacktraces as arrays; intake stores them per-frame,
      // and a single string arrives as a one-frame trace nobody can read.
      const error = new Error('boom');

      const payload = build({ message: 'boom', status: 500, error });

      expect(Array.isArray(payload.stacktrace)).toBe(true);
      expect(payload.stacktrace.length).toBeGreaterThan(0);
    });

    test('excludes the error message line, which is already the message', () => {
      const error = new Error('boom');

      expect(build({ message: 'boom', status: 500, error }).stacktrace[0]).toMatch(/^at /);
    });

    test('has no blank or padded frames', () => {
      const error = new Error('boom');

      for (const frame of build({ message: 'boom', status: 500, error }).stacktrace) {
        expect(frame).toBe(frame.trim());
        expect(frame).not.toBe('');
      }
    });

    test('prefers a stacktrace the caller supplied over the error\'s own', () => {
      const error = new Error('boom');

      const payload = build({
        message: 'boom',
        status: 500,
        error,
        stacktrace: ['at handcrafted (a.js:1:1)'],
      });

      expect(payload.stacktrace).toEqual(['at handcrafted (a.js:1:1)']);
    });

    test('is null when there is no error to trace', () => {
      expect(build({ message: 'boom', status: 500 }).stacktrace).toBeNull();
    });

    test('is null for an error carrying no stack', () => {
      const error = new Error('boom');
      delete error.stack;

      expect(build({ message: 'boom', status: 500, error }).stacktrace).toBeNull();
    });
  });

  describe('the request it was serving', () => {
    test('is absent when the payload is built outside a request', () => {
      const payload = build({ message: 'boom', status: 500 });

      expect(payload.url).toBeNull();
      expect(payload.request).toBeNull();
    });

    test('reconstructs the full URL the client called', () => {
      const req = { protocol: 'https', headers: { host: 'api.example.test' }, originalUrl: '/v1/students?q=1' };

      expect(build({ message: 'boom', status: 500 }, req).url).toBe(
        'https://api.example.test/v1/students?q=1',
      );
    });

    test('infers https from an encrypted connection when the framework did not say', () => {
      // A bare Node `IncomingMessage` has no `protocol`; reporting the wrong
      // scheme makes the logged URL unusable for reproducing the call.
      const req = { connection: { encrypted: true }, headers: { host: 'api.example.test' }, url: '/x' };

      expect(build({ message: 'boom', status: 500 }, req).url).toBe('https://api.example.test/x');
    });

    test('infers http for a plain connection', () => {
      const req = { connection: {}, headers: { host: 'api.example.test' }, url: '/x' };

      expect(build({ message: 'boom', status: 500 }, req).url).toBe('http://api.example.test/x');
    });

    test('falls back to the resolved hostname when there is no Host header', () => {
      const req = { protocol: 'http', hostname: 'api.example.test', url: '/x' };

      expect(build({ message: 'boom', status: 500 }, req).url).toBe('http://api.example.test/x');
    });

    test('falls back to localhost when the host is unknowable', () => {
      const req = { protocol: 'http', url: '/x' };

      expect(build({ message: 'boom', status: 500 }, req).url).toBe('http://localhost/x');
    });

    test('serialises a parsed body so it survives the wire', () => {
      const req = { protocol: 'http', headers: {}, url: '/x', body: { amount: 42 } };

      expect(build({ message: 'boom', status: 500 }, req).request).toBe('{"amount":42}');
    });

    test('passes a raw string body through unchanged', () => {
      const req = { protocol: 'http', headers: {}, url: '/x', body: 'amount=42' };

      expect(build({ message: 'boom', status: 500 }, req).request).toBe('amount=42');
    });

    test('sends null when no body parser ran', () => {
      const req = { protocol: 'http', headers: {}, url: '/x' };

      expect(build({ message: 'boom', status: 500 }, req).request).toBeNull();
    });

    test('sends null rather than throwing on a body that cannot be serialised', () => {
      // Error reporting must not itself raise; a circular body would otherwise
      // replace the customer's real error with a TypeError from the reporter.
      const circular = { name: 'loop' };
      circular.self = circular;
      const req = { protocol: 'http', headers: {}, url: '/x', body: circular };

      expect(build({ message: 'boom', status: 500 }, req).request).toBeNull();
    });
  });
});
