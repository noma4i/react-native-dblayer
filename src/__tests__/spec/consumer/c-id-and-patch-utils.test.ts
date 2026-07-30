import { generateTempId, isTempId, pickDefined, pickPresent, stringifyNullish } from '../../legacyTestApi';

// Named behavioral contracts for pure utility exports that previously had no direct tests.

describe('generateTempId / isTempId', () => {
  it('never re-issues an id when the wall clock rolls backwards', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(2_000);
      const before = generateTempId('clock');
      nowSpy.mockReturnValue(1_000);
      const rolledBack = generateTempId('clock');
      const rolledBackNext = generateTempId('clock');
      nowSpy.mockReturnValue(2_000);
      const recovered = generateTempId('clock');

      const ids = [before, rolledBack, rolledBackNext, recovered];
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('generates unique, temp-prefixed ids under rapid-fire calls', () => {
    const ids = Array.from({ length: 100 }, () => generateTempId());
    expect(new Set(ids).size).toBe(100);
    expect(ids.every(id => id.startsWith('temp-'))).toBe(true);
  });

  it('folds the prefix into the id and stays recognizable', () => {
    const id = generateTempId('message');
    expect(id.startsWith('temp-message-')).toBe(true);
    expect(isTempId(id)).toBe(true);
  });

  it('rejects server ids and nullish values in isTempId', () => {
    expect(isTempId('srv-1')).toBe(false);
    expect(isTempId(null)).toBe(false);
    expect(isTempId(undefined)).toBe(false);
  });
});

describe('stringifyNullish', () => {
  it('stringifies non-nullish values via String()', () => {
    expect(stringifyNullish(5)).toBe('5');
    expect(stringifyNullish('x')).toBe('x');
    expect(stringifyNullish(false)).toBe('false');
    expect(stringifyNullish('')).toBe('');
  });

  it('preserves null and undefined as-is', () => {
    expect(stringifyNullish(null)).toBeNull();
    expect(stringifyNullish(undefined)).toBeUndefined();
  });
});

describe('pickDefined / pickPresent', () => {
  const source = { a: 1, b: null, c: undefined, d: 'keep' } as { a: number; b: null; c: undefined; d: string };

  it('pickDefined keeps explicit null, drops undefined, ignores unlisted keys', () => {
    expect(pickDefined(source, ['a', 'b', 'c'])).toEqual({ a: 1, b: null });
  });

  it('pickPresent drops both null and undefined', () => {
    expect(pickPresent(source, ['a', 'b', 'c', 'd'])).toEqual({ a: 1, d: 'keep' });
  });
});
