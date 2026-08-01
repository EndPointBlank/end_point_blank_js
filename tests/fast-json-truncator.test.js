'use strict';

const { FastJsonTruncator } = require('../src/fast-json-truncator');

const parsed = value => JSON.parse(FastJsonTruncator.truncate(value));

describe('FastJsonTruncator.truncate', () => {
  describe('data that is already small', () => {
    test('survives intact', () => {
      const data = { id: 7, name: 'ada', tags: ['a', 'b'], active: true, meta: null };

      expect(parsed(data)).toEqual(data);
    });

    test.each([
      ['a number', 42],
      ['a string', 'hello'],
      ['a boolean', false],
      ['null', null],
      ['an empty object', {}],
      ['an empty array', []],
    ])('handles %s at the top level', (_label, value) => {
      expect(parsed(value)).toEqual(value);
    });
  });

  describe('pruning', () => {
    test('keeps the first 20 elements of a long array', () => {
      // Bounding the shape before serialising is what keeps a 50k-row response
      // from being serialised in full just to be thrown away by the byte cap.
      const out = parsed(Array.from({ length: 500 }, (_, i) => i));

      expect(out).toHaveLength(20);
      expect(out[0]).toBe(0);
      expect(out[19]).toBe(19);
    });

    test('keeps the first 20 keys of a wide object', () => {
      const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));

      expect(Object.keys(parsed(wide))).toHaveLength(20);
    });

    test('replaces anything nested more than five deep with a marker', () => {
      const out = parsed({ a: { b: { c: { d: { e: { f: { g: 'buried' } } } } } } });

      expect(out.a.b.c.d.e.f).toBe('[truncated]');
    });

    test('keeps structure down to the depth limit', () => {
      const out = parsed({ a: { b: { c: { d: { e: 'still here' } } } } });

      expect(out.a.b.c.d.e).toBe('still here');
    });

    test('shortens a long string and marks it', () => {
      const out = parsed({ note: 'x'.repeat(1000) });

      expect(out.note.endsWith('...')).toBe(true);
      expect(out.note.length).toBeLessThan(1000);
    });

    test('leaves a string within the per-string budget alone', () => {
      const out = parsed({ note: 'x'.repeat(50) });

      expect(out.note).toBe('x'.repeat(50));
    });

    test('prunes strings nested inside arrays and objects, not just top-level ones', () => {
      const out = parsed({ items: [{ note: 'y'.repeat(1000) }] });

      expect(out.items[0].note.endsWith('...')).toBe(true);
    });

    test('applies the array limit at every level', () => {
      const out = parsed({ rows: Array.from({ length: 50 }, () => Array.from({ length: 50 }, (_, i) => i)) });

      expect(out.rows).toHaveLength(20);
      expect(out.rows[0]).toHaveLength(20);
    });
  });

  test('produces a JSON string, not an object', () => {
    expect(typeof FastJsonTruncator.truncate({ a: 1 })).toBe('string');
  });
});
