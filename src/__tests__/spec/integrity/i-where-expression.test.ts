import { createCollection, createLiveQueryCollection } from '@tanstack/db';
import { compileWhereExpression, matchesDbWhere, OWNED_COLLECTION_LIFETIME, SyncFeed } from '../../testApi';
import type { DbWhere } from '../../testApi';

type Row = { id: string; label: string; rank: number; flag: boolean; note?: string | null };

/**
 * The declared filter has exactly one meaning. Answering it with a predicate in one place and with a
 * query expression in another gives a model read and a live query two different answers to the same
 * question, and the difference only shows on the rows nobody wrote a test for. So the two are held
 * to the same adversarial rows: mixed types, nullish values, empty strings and boundary numbers.
 */
const ROWS: Row[] = [
  { id: 'a', label: 'alpha', rank: 1, flag: true, note: 'hello world' },
  { id: 'b', label: 'beta', rank: 2, flag: false, note: null },
  { id: 'c', label: 'gamma', rank: -3, flag: true, note: '' },
  { id: 'd', label: '', rank: 0, flag: false, note: 'hell' },
  { id: 'e', label: 'Alpha', rank: 10, flag: true, note: 'HELLO' },
  { id: 'f', label: '100%', rank: 5, flag: false, note: 'a_b' },
  // A row that never carried the field at all: absence is not the same value as `null`.
  { id: 'g', label: 'absent', rank: 7, flag: true }
];

let tag = 0;

const engineRows = (where: DbWhere<Row>): string[] => {
  const feed = new SyncFeed<Row>();
  const source = createCollection<Row>({
    ...OWNED_COLLECTION_LIFETIME,
    id: `spec-where-source-${(tag += 1)}`,
    getKey: row => row.id,
    startSync: true,
    sync: { sync: feed.sync }
  });
  feed.start();
  for (const row of ROWS) feed.pushMessage({ type: 'insert', value: row });
  feed.finish();
  feed.markReady();
  const live = createLiveQueryCollection({
    ...OWNED_COLLECTION_LIFETIME,
    id: `spec-where-live-${tag}`,
    startSync: true,
    query: q => q.from({ row: source }).where(({ row }) => compileWhereExpression(row, where)),
    getKey: row => row.id
  });
  return [...live.toArray].map(row => (row as Row).id).sort();
};

const predicateRows = (where: DbWhere<Row>): string[] => ROWS.filter(row => matchesDbWhere(row, where)).map(row => row.id).sort();

/** Every case names the exact rows the filter selects out of ROWS: the literal is the contract, both paths must reach it. */
const CASES: Array<[string, DbWhere<Row>, string[]]> = [
  ['equality on a string', { label: 'alpha' }, ['a']],
  ['equality on an empty string', { label: '' }, ['d']],
  ['equality on a number', { rank: 2 }, ['b']],
  ['equality on zero', { rank: 0 }, ['d']],
  ['equality on a boolean', { flag: true }, ['a', 'c', 'e', 'g']],
  ['equality on null selects the null row, not the absent one', { note: null }, ['b']],
  ['two fields at once', { label: 'alpha', flag: true }, ['a']],
  ['gt on a number', { rank: { gt: 0 } }, ['a', 'b', 'e', 'f', 'g']],
  ['gte on a number', { rank: { gte: 1 } }, ['a', 'b', 'e', 'f', 'g']],
  ['lt on a negative bound', { rank: { lt: 0 } }, ['c']],
  ['lte on a number', { rank: { lte: 2 } }, ['a', 'b', 'c', 'd']],
  ['gt on a string compares by codepoint', { label: { gt: 'b' } }, ['b', 'c']],
  ['lt on a string compares by codepoint', { label: { lt: 'b' } }, ['a', 'd', 'e', 'f', 'g']],
  ['range on one field', { rank: { gt: 0, lte: 2 } }, ['a', 'b']],
  ['in over strings', { label: { in: ['alpha', 'beta'] } }, ['a', 'b']],
  ['in over numbers', { rank: { in: [1, 10] } }, ['a', 'e']],
  ['in over nothing', { label: { in: [] } }, []],
  ['notIn over strings', { label: { notIn: ['alpha'] } }, ['b', 'c', 'd', 'e', 'f', 'g']],
  ['and of two leaves', { and: [{ flag: true }, { rank: { gt: 0 } }] }, ['a', 'e', 'g']],
  ['or of two leaves', { or: [{ label: 'alpha' }, { label: 'beta' }] }, ['a', 'b']],
  ['not of a leaf', { not: { flag: true } }, ['b', 'd', 'f']],
  ['not of an or', { not: { or: [{ label: 'alpha' }, { label: 'beta' }] } }, ['c', 'd', 'e', 'f', 'g']],
  ['nested and inside or', { or: [{ and: [{ flag: true }, { rank: { lt: 0 } }] }, { label: 'beta' }] }, ['b', 'c']],
  ['or of one leaf', { or: [{ label: 'alpha' }] }, ['a']],
  ['and of one leaf', { and: [{ label: 'alpha' }] }, ['a']],
  ['and of nothing admits every row', { and: [] }, ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
  ['notIn admits the null and the absent field', { note: { notIn: ['hello world'] } }, ['b', 'c', 'd', 'e', 'f', 'g']],
  ['gt on a string skips null, absent and non-string values', { note: { gt: 'a' } }, ['a', 'd', 'f']],
  ['not of a null equality', { not: { note: null } }, ['a', 'c', 'd', 'e', 'f', 'g']],
  ['or with a null equality', { or: [{ note: null }, { label: 'beta' }] }, ['b']]
];

describe('where expression compilation', () => {
  it.each(CASES)('selects the named rows through the live query and the predicate: %s', (_name, where, expected) => {
    expect(engineRows(where)).toEqual(expected);
    expect(predicateRows(where)).toEqual(expected);
  });

  it('admits no row for a choice between nothing', () => {
    // The mirror of an empty `and`: a filter that offers no alternative is met by no row.
    expect(engineRows({ or: [] })).toEqual([]);
    expect(predicateRows({ or: [] })).toEqual([]);
  });

  it('matches every row when the filter carries no condition', () => {
    expect(engineRows({})).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(predicateRows({})).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('ignores a field whose value is undefined', () => {
    expect(engineRows({ label: undefined, flag: true })).toEqual(['a', 'c', 'e', 'g']);
    expect(predicateRows({ label: undefined, flag: true })).toEqual(['a', 'c', 'e', 'g']);
  });
});
