import { compareOrderValues, createFieldOrderComparator, withIdTieBreak } from '../../testApi';

const sign = (value: number): number => (value === 0 ? 0 : value < 0 ? -1 : 1);

describe('canonical ordering laws', () => {
  it('sorts every value with no position after the ordered ones, and absence after those', () => {
    const absentValues = [null, undefined];
    const unorderableValues = [Number.NaN, new Date(Number.NaN)];

    for (const value of [...absentValues, ...unorderableValues]) {
      expect(compareOrderValues(value, 1)).toBeGreaterThan(0);
      expect(compareOrderValues(1, value)).toBeLessThan(0);
    }
    for (const absent of absentValues) {
      for (const other of absentValues) expect(compareOrderValues(absent, other)).toBe(0);
      // Absence is the last place of all: it follows even a value that has no position in its type.
      for (const unorderable of unorderableValues) expect(compareOrderValues(absent, unorderable)).toBeGreaterThan(0);
    }
    for (const unorderable of unorderableValues) {
      for (const other of unorderableValues) expect(compareOrderValues(unorderable, other)).toBe(0);
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

  it('reverses an unorderable value with the direction while absence stays last', () => {
    const rows = [
      { id: 'absent-z' },
      { id: 'finite', score: 2 },
      { id: 'unorderable-a', score: Number.NaN }
    ];

    const descending = [...rows].sort(createFieldOrderComparator<{ id: string; score?: number }>([{ field: 'score', direction: 'desc' }]));
    const ascending = [...rows].sort(createFieldOrderComparator<{ id: string; score?: number }>([{ field: 'score', direction: 'asc' }]));

    expect(descending.map(row => row.id)).toEqual(['unorderable-a', 'finite', 'absent-z']);
    expect(ascending.map(row => row.id)).toEqual(['finite', 'unorderable-a', 'absent-z']);
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
