import { generateTempId, isIncomingNewer, isTempId, pickDefined, pickPresent, stringifyNullish } from '../../../index';

// Named behavioral contracts for pure utility exports that previously had no direct tests.

describe('generateTempId / isTempId', () => {
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

describe('isIncomingNewer', () => {
  it('applies the documented nullish policy', () => {
    expect(isIncomingNewer(null, null)).toBe(true);
    expect(isIncomingNewer('2026-01-01T00:00:00Z', null)).toBe(false);
    expect(isIncomingNewer(null, '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('accepts equal timestamps and rejects strictly older incoming ones', () => {
    expect(isIncomingNewer('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(true);
    expect(isIncomingNewer('2026-01-01T00:00:01Z', '2026-01-01T00:00:00Z')).toBe(false);
    expect(isIncomingNewer('2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')).toBe(true);
  });

  it('compares across timezone offsets by instant, not by string', () => {
    expect(isIncomingNewer('2026-01-01T00:00:00+11:00', '2025-12-31T13:00:00Z')).toBe(true);
    expect(isIncomingNewer('2025-12-31T13:00:00Z', '2026-01-01T00:00:00+11:00')).toBe(true);
  });
});
