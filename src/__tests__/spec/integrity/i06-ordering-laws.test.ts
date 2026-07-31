import { compareOrderValues, createFieldOrderComparator, withIdTieBreak } from '../../testApi';

const sign = (value: number): number => (value === 0 ? 0 : value < 0 ? -1 : 1);

describe('canonical ordering laws', () => {
  it('keeps missing values last in both directions and equal to each other', () => {
    const missingValues = [null, undefined, Number.NaN, new Date(Number.NaN)];

    for (const missing of missingValues) {
      expect(compareOrderValues(missing, 1)).toBeGreaterThan(0);
      expect(compareOrderValues(1, missing)).toBeLessThan(0);
      for (const otherMissing of missingValues) {
        expect(compareOrderValues(missing, otherMissing)).toBe(0);
      }
    }
  });

  it('is antisymmetric across every defensively supported runtime value class', () => {
    const values = [false, true, -2, 0, 3, 1n, 2n, 'a', 'b', new Date(1), new Date(2), { value: 1 }, { value: 2 }];

    for (const left of values) {
      for (const right of values) {
        const reverseSign = sign(compareOrderValues(right, left));
        expect(sign(compareOrderValues(left, right))).toBe(reverseSign === 0 ? 0 : -reverseSign);
      }
    }
  });

  it('keeps missing values last for descending field order and resolves ties by id', () => {
    const compare = createFieldOrderComparator<{ id: string; score?: number }>([{ field: 'score', direction: 'desc' }]);
    const rows = [
      { id: 'missing-z' },
      { id: 'finite', score: 2 },
      { id: 'missing-a', score: Number.NaN }
    ];

    expect(rows.sort(compare).map(row => row.id)).toEqual(['finite', 'missing-a', 'missing-z']);
  });

  it('replaces zero and NaN comparator ties with the canonical id order', () => {
    const zeroComparator = withIdTieBreak<{ id: string }>(() => 0);
    const nanComparator = withIdTieBreak<{ id: string }>(() => Number.NaN);
    const left = { id: 'a' };
    const right = { id: 'z' };

    expect(zeroComparator(left, right)).toBeLessThan(0);
    expect(nanComparator(left, right)).toBeLessThan(0);
  });
});
