'use strict';

const { LogEntry } = require('../src/log-entry');

describe('LogEntry', () => {
  const fields = {
    message: 'payment declined',
    stacktrace: ['at charge (billing.js:12:3)'],
    app: 'billing',
    status: 402,
    headers: { 'content-type': 'application/json' },
    body: '{"amount":42}',
    env: { requestId: 'abc' },
  };

  test('keeps every field it was given', () => {
    expect(new LogEntry(fields)).toMatchObject(fields);
  });

  test('stamps itself with the current time when none is given', () => {
    const before = Date.now();

    const entry = new LogEntry(fields);

    expect(entry.sentAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(entry.sentAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('keeps a caller-supplied time', () => {
    // A queued entry is written later than it happened, so the caller's
    // timestamp has to win over the moment of construction.
    const sentAt = new Date('2026-08-01T14:15:16Z');

    expect(new LogEntry({ ...fields, sentAt }).sentAt).toBe(sentAt);
  });

  test('accepts an entry with nothing but a message', () => {
    const entry = new LogEntry({ message: 'hello' });

    expect(entry.message).toBe('hello');
    expect(entry.stacktrace).toBeUndefined();
    expect(entry.sentAt).toBeInstanceOf(Date);
  });
});
