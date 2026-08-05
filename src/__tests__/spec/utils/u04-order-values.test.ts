import { compareOrderValues, compareRowsBySpec, createFieldOrderComparator, withIdTieBreak } from '../../testApi';

/**
 * Owner contract of the total order behind every declaratively sorted scope: missing values sort
 * last regardless of direction, ranks separate value types deterministically, same-type values
 * compare by their domain, and ties always fall through to the codepoint id.
 */
describe('order value total order', () => {
  it('sorts every missing shape last and treats two missing values as equal', () => {
    expect(compareOrderValues(null, 1)).toBe(1);
    expect(compareOrderValues(1, null)).toBe(-1);
    expect(compareOrderValues(undefined, 'a')).toBe(1);
    expect(compareOrderValues(Number.NaN, 5)).toBe(1);
    expect(compareOrderValues(new Date(Number.NaN), new Date(0))).toBe(1);
    expect(compareOrderValues(null, undefined)).toBe(0);
    expect(compareOrderValues(Number.NaN, new Date(Number.NaN))).toBe(0);
  });

  it('treats identical and interchangeable values as equal', () => {
    expect(compareOrderValues(5, 5)).toBe(0);
    expect(compareOrderValues('same', 'same')).toBe(0);
    expect(compareOrderValues(-0, 0)).toBe(0);
    expect(compareOrderValues(0, -0)).toBe(0);
  });

  it('ranks value types boolean < number < bigint < string < date < other', () => {
    const date = new Date(0);
    const plain = { nested: true };
    expect(compareOrderValues(true, -100)).toBe(-1);
    expect(compareOrderValues(-100, 5n)).toBe(-1);
    expect(compareOrderValues(5n, '')).toBe(-1);
    expect(compareOrderValues('zzz', date)).toBe(-1);
    expect(compareOrderValues(date, plain)).toBe(-1);
    expect(compareOrderValues(plain, date)).toBe(1);
    expect(compareOrderValues(date, 'zzz')).toBe(1);
    expect(compareOrderValues('', 5n)).toBe(1);
    expect(compareOrderValues(5n, -100)).toBe(1);
    expect(compareOrderValues(-100, true)).toBe(1);
  });

  it('compares same-type values by their domain order', () => {
    expect(compareOrderValues(1, 2)).toBe(-1);
    expect(compareOrderValues(2, 1)).toBe(1);
    expect(compareOrderValues(1n, 2n)).toBe(-1);
    expect(compareOrderValues(false, true)).toBe(-1);
    expect(compareOrderValues(true, false)).toBe(1);
    expect(compareOrderValues('Z', 'a')).toBe(-1);
    expect(compareOrderValues('a', 'Z')).toBe(1);
    expect(compareOrderValues(new Date(1), new Date(2))).toBe(-1);
    expect(compareOrderValues(new Date(2), new Date(1))).toBe(1);
  });

  it('compares rank-5 values by their stable serialization', () => {
    expect(compareOrderValues({ a: 1 }, { a: 1 })).toBe(0);
    const forward = compareOrderValues({ a: 1 }, { b: 2 });
    expect(forward === 1 || forward === -1).toBe(true);
    expect(compareOrderValues({ b: 2 }, { a: 1 })).toBe(-forward);
  });

  it('[R12] breaks comparator ties and NaN results by codepoint id', () => {
    const tie = withIdTieBreak<{ id: string }>(() => 0);
    expect(tie({ id: 'a' }, { id: 'b' })).toBeLessThan(0);
    expect(tie({ id: 'b' }, { id: 'a' })).toBeGreaterThan(0);
    const nan = withIdTieBreak<{ id: string }>(() => Number.NaN);
    expect(nan({ id: 'a' }, { id: 'b' })).toBeLessThan(0);
    const decisive = withIdTieBreak<{ id: string }>(() => -5);
    expect(decisive({ id: 'z' }, { id: 'a' })).toBe(-5);
  });

  it('keeps missing values last even under a descending field order', () => {
    const compare = createFieldOrderComparator<{ id: string; seq: number | null }>([{ field: 'seq', direction: 'desc' }]);
    const rows = [
      { id: 'r-null', seq: null },
      { id: 'r-1', seq: 1 },
      { id: 'r-3', seq: 3 }
    ];
    expect([...rows].sort(compare).map(row => row.id)).toEqual(['r-3', 'r-1', 'r-null']);
    const ascending = createFieldOrderComparator<{ id: string; seq: number | null }>([{ field: 'seq', direction: 'asc' }]);
    expect([...rows].sort(ascending).map(row => row.id)).toEqual(['r-1', 'r-3', 'r-null']);
  });

  it('falls through equal leading fields to the next field and finally to the id', () => {
    const compare = createFieldOrderComparator<{ id: string; group: string; seq: number }>([
      { field: 'group', direction: 'asc' },
      { field: 'seq', direction: 'desc' }
    ]);
    const rows = [
      { id: 'b-tie', group: 'g1', seq: 5 },
      { id: 'a-tie', group: 'g1', seq: 5 },
      { id: 'high', group: 'g1', seq: 9 },
      { id: 'other-group', group: 'g0', seq: 1 }
    ];
    expect([...rows].sort(compare).map(row => row.id)).toEqual(['other-group', 'high', 'a-tie', 'b-tie']);
  });

  it('builds the same canonical comparator from all three sort spec forms', () => {
    type Row = { id: string; seq: number };
    const rows: Row[] = [
      { id: 'r2', seq: 2 },
      { id: 'r1', seq: 1 }
    ];
    const byField = compareRowsBySpec<Row>({ field: 'seq', dir: 'asc' });
    const byList = compareRowsBySpec<Row>([{ field: 'seq', dir: 'asc' }]);
    const byComparator = compareRowsBySpec<Row>({ comparator: (left, right) => left.seq - right.seq });
    for (const compare of [byField, byList, byComparator]) {
      expect([...rows].sort(compare).map(row => row.id)).toEqual(['r1', 'r2']);
    }
  });
});
