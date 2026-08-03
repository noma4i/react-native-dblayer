import { isOrderKey, keyAfter, keyBefore, keyBetween, keysForSequence } from '../../testApi';

/**
 * Owner contract of the fractional order keys every sorted scope persists: strict lexical
 * betweenness, deterministic even distribution, and the chained-walk fallback when bounds get
 * too tight for even spacing.
 */
describe('fractional order keys', () => {
  it('produces a key strictly between its bounds in codepoint order', () => {
    const middle = keyBetween('a', 'c');
    expect(middle > 'a' && middle < 'c').toBe(true);
    const tight = keyBetween('a', 'b');
    expect(tight > 'a' && tight < 'b').toBe(true);
    const nested = keyBetween('aa', 'ab');
    expect(nested > 'aa' && nested < 'ab').toBe(true);
    expect(keyBefore('a') < 'a').toBe(true);
    expect(keyAfter('z') > 'z').toBe(true);
    expect(isOrderKey(middle)).toBe(true);
  });

  it('throws on inverted or non-base62 bounds', () => {
    expect(() => keyBetween('c', 'a')).toThrow('Invalid fractional order bounds');
    expect(() => keyBetween('!', 'a')).toThrow('Invalid fractional order bounds');
  });

  it('distributes sequence keys strictly increasing and inside the bounds', () => {
    const keys = keysForSequence(5, 'B', 'x');
    expect(keys).toHaveLength(5);
    for (let index = 0; index < keys.length; index += 1) {
      expect(keys[index]! > 'B').toBe(true);
      expect(keys[index]! < 'x').toBe(true);
      if (index > 0) expect(keys[index]! > keys[index - 1]!).toBe(true);
    }
    expect(new Set(keys.map(key => key.length)).size).toBe(1);
    expect(keysForSequence(0)).toEqual([]);
    expect(keysForSequence(-2)).toEqual([]);
  });

  it('is deterministic for identical inputs', () => {
    const firstBoundedSequence = keysForSequence(4, 'a', 'b');
    const secondBoundedSequence = keysForSequence(4, 'a', 'b');
    expect(firstBoundedSequence).toEqual(secondBoundedSequence);
    const firstDefaultSequence = keysForSequence(3);
    const secondDefaultSequence = keysForSequence(3);
    expect(firstDefaultSequence).toEqual(secondDefaultSequence);
  });

  it('falls back to a chained walk between adjacent bounds and stays strictly ordered', () => {
    // Adjacent long bounds leave no room for even distribution at any allowed length.
    const lower = '0000000000';
    const upper = '0000000001';
    const keys = keysForSequence(3, lower, upper);
    expect(keys).toHaveLength(3);
    let previous = lower;
    for (const key of keys) {
      expect(key > previous).toBe(true);
      expect(key < upper).toBe(true);
      previous = key;
    }
  });
});
