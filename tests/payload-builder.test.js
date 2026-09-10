'use strict';

const { PayloadBuilder } = require('../src/payload-builder');
const { RequestStore } = require('../src/request-store');
const { instance: config } = require('../src/configuration');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    test('carries the message and the configured application', () => {
      const payload = build({ message: 'boom' });

      expect(payload).toMatchObject({ message: 'boom', app_name: 'billing' });
    });

    test('stamps the time as an ISO 8601 string', () => {
      const payload = build({ message: 'boom', sentAt: new Date('2026-08-01T14:15:16Z') });

      expect(payload.sent_at).toBe('2026-08-01T14:15:16.000Z');
    });

    test('stamps the current time when none is supplied', () => {
      const before = Date.now();

      const stamped = Date.parse(build({ message: 'boom' }).sent_at);

      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(Date.now());
    });

    test('defaults the optional route details to null rather than omitting them', () => {
      const payload = build({ message: 'boom' });

      expect(payload.stamped_path).toBeNull();
      expect(payload.stamped_http_method).toBeNull();
      expect(payload.source_application_environment_id).toBeNull();
    });
  });

  describe('the correlation id', () => {
    // Intake requires a `uuid` on every error row. Without one the row is
    // refused, and since sc-310 a batch of nothing but refused rows answers
    // 422 rather than the 201 it used to.
    test('is always present', () => {
      expect(build({ message: 'boom' }).uuid).toEqual(expect.any(String));
    });

    test('is the id the SDK minted for the request being served', () => {
      // This is the join to the request and response rows for the same call,
      // which is where the fields intake does not keep on an error row live.
      let minted;
      const req = { path: '/x', method: 'GET' };

      const payload = RequestStore.run(req, () => {
        minted = RequestStore.getUuid();
        return PayloadBuilder.build({ message: 'boom' });
      });

      expect(payload.uuid).toBe(minted);
    });

    test('is minted outside a request rather than left null', () => {
      // A background job or a startup failure has no request to borrow an id
      // from, and `null` is a rejected row. An id that correlates with nothing
      // still records the error.
      expect(build({ message: 'boom' }).uuid).toMatch(UUID_V4);
    });

    test('gives two unrelated reports two different ids', () => {
      expect(build({ message: 'one' }).uuid).not.toBe(build({ message: 'two' }).uuid);
    });

    test('prefers a correlation id the caller supplied', () => {
      // The way a caller not running the middleware carries an inbound
      // X-Request-Id onto the row.
      expect(build({ message: 'boom', uuid: 'req-abc' }).uuid).toBe('req-abc');
    });

    test('prefers the caller\'s id over the one minted for the request', () => {
      const payload = build({ message: 'boom', uuid: 'req-abc' }, { path: '/x', method: 'GET' });

      expect(payload.uuid).toBe('req-abc');
    });
  });

  describe('the stacktrace', () => {
    test('is an array of frames, never one blob of text', () => {
      // Every SDK sends stacktraces as arrays; intake stores them per-frame,
      // and a single string arrives as a one-frame trace nobody can read.
      const error = new Error('boom');

      const payload = build({ message: 'boom', error });

      expect(Array.isArray(payload.stacktrace)).toBe(true);
      expect(payload.stacktrace.length).toBeGreaterThan(0);
    });

    test('excludes the error message line, which is already the message', () => {
      const error = new Error('boom');

      expect(build({ message: 'boom', error }).stacktrace[0]).toMatch(/^at /);
    });

    test('has no blank or padded frames', () => {
      const error = new Error('boom');

      for (const frame of build({ message: 'boom', error }).stacktrace) {
        expect(frame).toBe(frame.trim());
        expect(frame).not.toBe('');
      }
    });

    test('prefers a stacktrace the caller supplied over the error\'s own', () => {
      const error = new Error('boom');

      const payload = build({
        message: 'boom',
        error,
        stacktrace: ['at handcrafted (a.js:1:1)'],
      });

      expect(payload.stacktrace).toEqual(['at handcrafted (a.js:1:1)']);
    });

    test('is null when there is no error to trace', () => {
      expect(build({ message: 'boom' }).stacktrace).toBeNull();
    });

    test('is null for an error carrying no stack', () => {
      const error = new Error('boom');
      delete error.stack;

      expect(build({ message: 'boom', error }).stacktrace).toBeNull();
    });
  });

  describe('the request it was serving', () => {
    test('stamps the route under the name intake reads', () => {
      const req = { path: '/v1/students', method: 'GET' };

      expect(build({ message: 'boom' }, req).stamped_path).toBe('/v1/students');
    });

    test('stamps the HTTP method under the name intake reads', () => {
      const req = { path: '/v1/students', method: 'GET' };

      expect(build({ message: 'boom' }, req).stamped_http_method).toBe('GET');
    });

    test('falls back to the full URL when the framework exposes no path', () => {
      // A bare Node `IncomingMessage` has no `path`; the same fallback
      // `ExceptionWriter` makes.
      const req = { originalUrl: '/v1/students?q=1', method: 'GET' };

      expect(build({ message: 'boom' }, req).stamped_path).toBe('/v1/students?q=1');
    });

    test('prefers the route the caller named over the one in flight', () => {
      // A route pattern beats a concrete path for grouping, and the caller is
      // the only one who has it.
      const req = { path: '/v1/students/7', method: 'GET' };

      const payload = build({ message: 'boom', path: '/v1/students/:id', action: 'PATCH' }, req);

      expect(payload.stamped_path).toBe('/v1/students/:id');
      expect(payload.stamped_http_method).toBe('PATCH');
    });

    test('carries the source application environment resolved for the request', () => {
      const req = { path: '/x', method: 'GET' };

      const payload = RequestStore.run(req, () => {
        RequestStore.setSourceApplicationEnvironmentId('env-99');
        return PayloadBuilder.build({ message: 'boom' });
      });

      expect(payload.source_application_environment_id).toBe('env-99');
    });
  });

  describe('the options intake has nowhere to put', () => {
    // `status`, `headers` and `version` stay in the signature so existing
    // calls keep working, but `application_errors` has no column for any of
    // them and the error controller's `build_attrs/2` does not read them.
    // Sending them anyway is what made eight of the twelve keys on this
    // payload dead weight.
    test('accepts them without sending them', () => {
      const payload = build({
        message: 'boom',
        status: 500,
        headers: { authorization: 'Bearer x' },
        version: '2',
      });

      expect(payload).not.toHaveProperty('status');
      expect(payload).not.toHaveProperty('request_headers');
      expect(payload).not.toHaveProperty('headers');
      expect(payload).not.toHaveProperty('endpoint_version');
      expect(payload).not.toHaveProperty('version');
    });

    test('does not send the request it was serving, which lives on the request row', () => {
      const req = {
        protocol: 'https',
        headers: { host: 'api.example.test' },
        originalUrl: '/v1/students?q=1',
        path: '/v1/students',
        method: 'POST',
        body: { amount: 42 },
      };

      const payload = build({ message: 'boom' }, req);

      expect(payload).not.toHaveProperty('url');
      expect(payload).not.toHaveProperty('request');
      expect(payload).not.toHaveProperty('env');
    });
  });
});
