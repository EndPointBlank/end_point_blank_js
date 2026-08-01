'use strict';

const { XmlTruncator } = require('../src/xml-truncator');

const bytes = s => Buffer.byteLength(s, 'utf8');

describe('XmlTruncator.truncate', () => {
  test('leaves a document that fits exactly as it was', () => {
    const xml = '<order><id>7</id></order>';

    expect(XmlTruncator.truncate(xml)).toBe(xml);
  });

  test('cuts an oversized document down to the byte budget', () => {
    const out = XmlTruncator.truncate(`<a>${'b'.repeat(20000)}</a>`);

    expect(bytes(out)).toBeLessThanOrEqual(10000);
  });

  test('marks a cut document so a reader can tell it is incomplete', () => {
    // The result is no longer well-formed XML — an unclosed tag with no marker
    // would look like a malformed request rather than a trimmed one.
    const out = XmlTruncator.truncate(`<a>${'b'.repeat(20000)}</a>`);

    expect(out.endsWith('<truncated/>')).toBe(true);
  });

  test('honours a caller-supplied budget', () => {
    const out = XmlTruncator.truncate(`<a>${'b'.repeat(500)}</a>`, { limit: 100 });

    expect(bytes(out)).toBeLessThanOrEqual(100);
    expect(out.endsWith('<truncated/>')).toBe(true);
  });

  test('does not split a multi-byte character while cutting', () => {
    const out = XmlTruncator.truncate(`<a>${'é'.repeat(200)}</a>`, { limit: 60 });

    expect(out).not.toContain('�');
  });

  describe('absent or non-string input', () => {
    test.each([[null], [undefined], ['']])('%p becomes an empty string', input => {
      expect(XmlTruncator.truncate(input)).toBe('');
    });

    test('a non-string body is stringified rather than rejected', () => {
      expect(XmlTruncator.truncate(123)).toBe('123');
    });
  });
});
