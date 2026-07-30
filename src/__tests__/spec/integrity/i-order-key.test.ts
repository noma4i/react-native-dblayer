import { compareCodepoints } from '../../../core/serialize';
import { keyAfter, keyBefore, keyBetween, keysForSequence } from '../../../core/orderKey';

/**
 * Lexical fractional order-key contracts: the single home for every scope order key. Keys are
 * base62 strings compared by code points; between any two keys a third always exists; sequence
 * generation distributes keys evenly instead of degrading through chained midpoints.
 */

const expectStrictlyIncreasing = (keys: readonly string[]): void => {
  for (let index = 1; index < keys.length; index += 1) {
    expect(compareCodepoints(keys[index - 1]!, keys[index]!)).toBe(-1);
  }
};

describe('order key primitives', () => {
  it('keyBetween with no bounds yields a non-empty key that does not end with the minimal digit', () => {
    const key = keyBetween(undefined, undefined);
    expect(key.length).toBeGreaterThan(0);
    expect(key.endsWith('0')).toBe(false);
  });

  it('keyBetween lands strictly between its bounds under codepoint comparison', () => {
    const lower = keyBetween(undefined, undefined);
    const upper = keyAfter(lower);
    const middle = keyBetween(lower, upper);
    expect(compareCodepoints(lower, middle)).toBe(-1);
    expect(compareCodepoints(middle, upper)).toBe(-1);
  });

  it('keyBefore and keyAfter produce keys strictly outside the given key', () => {
    const anchor = keyBetween(undefined, undefined);
    expect(compareCodepoints(keyBefore(anchor), anchor)).toBe(-1);
    expect(compareCodepoints(anchor, keyAfter(anchor))).toBe(-1);
  });

  it('keyBetween throws on inverted bounds', () => {
    const lower = keyBetween(undefined, undefined);
    const upper = keyAfter(lower);
    expect(() => keyBetween(upper, lower)).toThrow();
  });

  it('sustains 5000 sequential insertions into one gap without a precision limit', () => {
    const lower = keyBetween(undefined, undefined);
    const upper = keyAfter(lower);
    let previous = lower;
    for (let index = 0; index < 5000; index += 1) {
      const next = keyBetween(previous, upper);
      expect(compareCodepoints(previous, next)).toBe(-1);
      expect(compareCodepoints(next, upper)).toBe(-1);
      previous = next;
    }
    expect(compareCodepoints(lower, previous)).toBe(-1);
  });

  it('sustains 5000 sequential prepends without a precision limit', () => {
    let previous = keyBetween(undefined, undefined);
    for (let index = 0; index < 5000; index += 1) {
      const next = keyBefore(previous);
      expect(compareCodepoints(next, previous)).toBe(-1);
      previous = next;
    }
  });
});

describe('order key sequences', () => {
  it('returns no keys for a non-positive count and rejects malformed bounds', () => {
    expect(keysForSequence(0)).toEqual([]);
    expect(keysForSequence(-1)).toEqual([]);
    expect(() => keysForSequence(1, '!')).toThrow('Invalid fractional order bounds');
  });

  it('generates n strictly increasing keys with no bounds', () => {
    const keys = keysForSequence(1000);
    expect(keys).toHaveLength(1000);
    expectStrictlyIncreasing(keys);
    expect(keys.some(key => key.endsWith('0'))).toBe(false);
  });

  it('distributes evenly: a 1000-key rebuild stays short instead of degrading like a midpoint chain', () => {
    const keys = keysForSequence(1000);
    const longest = Math.max(...keys.map(key => key.length));
    expect(longest).toBeLessThanOrEqual(3);
  });

  it('generates keys strictly after a lower bound', () => {
    const tail = keysForSequence(3).at(-1)!;
    const appended = keysForSequence(50, tail);
    expect(appended).toHaveLength(50);
    expectStrictlyIncreasing([tail, ...appended]);
  });

  it('generates keys strictly between two bounds', () => {
    const [lower, upper] = [keyBetween(undefined, undefined), 'z'];
    const between = keysForSequence(50, lower, upper);
    expect(between).toHaveLength(50);
    expectStrictlyIncreasing([lower, ...between, upper]);
  });

  it('falls back to a chained walk when the bounds are too tight for even distribution', () => {
    let tail = keyBetween(undefined, undefined);
    for (let index = 0; index < 60; index += 1) tail = keyAfter(tail);
    const appended = keysForSequence(50, tail);
    expect(appended).toHaveLength(50);
    expectStrictlyIncreasing([tail, ...appended]);
  });

  it('keeps every generated sequence deterministic for identical inputs', () => {
    expect(keysForSequence(20, undefined, undefined)).toEqual(keysForSequence(20, undefined, undefined));
  });

  it('sorting generated keys with the default lexical string comparison matches compareCodepoints', () => {
    const keys = keysForSequence(200);
    const shuffled = [...keys].reverse();
    expect([...shuffled].sort()).toEqual([...shuffled].sort(compareCodepoints));
  });
});
