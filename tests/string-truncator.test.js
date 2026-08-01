'use strict';

const { StringTruncator } = require('../src/string-truncator');

const bytes = s => Buffer.byteLength(s, 'utf8');

// U+FFFD, what a split multi-byte sequence decodes to. Its presence anywhere in
// the output means a character was cut in half.
const REPLACEMENT = '�';

describe('StringTruncator.truncate', () => {
  describe('strings that already fit', () => {
    test('are returned untouched, with no suffix bolted on', () => {
      expect(StringTruncator.truncate('hello', { limit: 100 })).toBe('hello');
    });

    test('include one that lands exactly on the limit', () => {
      expect(StringTruncator.truncate('abcde', { limit: 5 })).toBe('abcde');
    });

    test('include multi-byte text measured in bytes, not characters', () => {
      // 'é' is two bytes: a character-counting implementation would wrongly
      // consider this within a 5-byte budget.
      const out = StringTruncator.truncate('ééé', { limit: 6 });

      expect(out).toBe('ééé');
    });
  });

  describe('strings that are too long', () => {
    test('are cut and marked as cut', () => {
      const out = StringTruncator.truncate('a'.repeat(50), { limit: 20, suffix: '<truncated>' });

      expect(out.endsWith('<truncated>')).toBe(true);
      expect(out).not.toBe('a'.repeat(50));
    });

    test('never exceed the byte budget, suffix included', () => {
      // The budget exists because the receiving API rejects oversized fields,
      // so the suffix has to come out of the allowance rather than on top of it.
      const out = StringTruncator.truncate('a'.repeat(5000), { limit: 100 });

      expect(bytes(out)).toBeLessThanOrEqual(100);
    });

    test('default to a 1000-byte budget', () => {
      expect(bytes(StringTruncator.truncate('a'.repeat(5000)))).toBeLessThanOrEqual(1000);
    });

    test('default to the <truncated> marker', () => {
      expect(StringTruncator.truncate('a'.repeat(5000)).endsWith('<truncated>')).toBe(true);
    });

    test('accept a custom suffix', () => {
      expect(StringTruncator.truncate('a'.repeat(50), { limit: 20, suffix: '…' }).endsWith('…')).toBe(
        true,
      );
    });
  });

  describe('multi-byte characters at the cut point', () => {
    // Half a character is not a character. A split sequence decodes to U+FFFD
    // and can make the whole payload fail a UTF-8 validity check on the way in.
    test.each([
      ['two-byte', 'é'],
      ['three-byte', '€'],
      ['four-byte', '🙂'],
    ])('a %s character is never cut in half', (_label, char) => {
      const input = char.repeat(40);

      // Sweep the cut across every possible offset within a character.
      for (let limit = 10; limit <= 30; limit++) {
        const out = StringTruncator.truncate(input, { limit, suffix: 'X' });

        expect(out).not.toContain(REPLACEMENT);
        expect(bytes(out)).toBeLessThanOrEqual(limit);
      }
    });

    test('drops the straddling character rather than padding up to the limit', () => {
      // Ten 'é' is 20 bytes. With a 15-byte budget and a 1-byte suffix there is
      // room for 14 bytes of text, which is seven whole characters — not seven
      // and a half.
      expect(StringTruncator.truncate('é'.repeat(10), { limit: 15, suffix: 'X' })).toBe(
        'ééééééé' + 'X',
      );
    });

    test('handles text that mixes ASCII and multi-byte characters', () => {
      const input = 'aébc€d🙂'.repeat(20);

      for (let limit = 12; limit <= 40; limit++) {
        const out = StringTruncator.truncate(input, { limit, suffix: '..' });

        expect(out).not.toContain(REPLACEMENT);
        expect(bytes(out)).toBeLessThanOrEqual(limit);
      }
    });
  });

  describe('absent input', () => {
    // Callers pass request and response bodies straight in, and a body is
    // routinely absent. Returning a string keeps the payload shape stable.
    test.each([[null], [undefined]])('%p becomes an empty string', input => {
      expect(StringTruncator.truncate(input)).toBe('');
    });

    test('an empty string stays empty', () => {
      expect(StringTruncator.truncate('')).toBe('');
    });
  });
});
