import { createCollection, createLiveQueryCollection } from '@tanstack/db';
import { compileWhereExpression, matchesDbWhere, OWNED_COLLECTION_LIFETIME, SyncFeed, WHERE_OPERATOR_NAMES } from '../../testApi';
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

const CASES: Array<[string, DbWhere<Row>]> = [
  ['equality on a string', { label: 'alpha' }],
  ['equality on an empty string', { label: '' }],
  ['equality on a number', { rank: 2 }],
  ['equality on zero', { rank: 0 }],
  ['equality on a boolean', { flag: true }],
  ['equality on null', { note: null }],
  ['two fields at once', { label: 'alpha', flag: true }],
  ['gt on a number', { rank: { gt: 0 } }],
  ['gte on a number', { rank: { gte: 1 } }],
  ['lt on a negative bound', { rank: { lt: 0 } }],
  ['lte on a number', { rank: { lte: 2 } }],
  ['gt on a string', { label: { gt: 'b' } }],
  ['lt on a string', { label: { lt: 'b' } }],
  ['range on one field', { rank: { gt: 0, lte: 2 } }],
  ['in over strings', { label: { in: ['alpha', 'beta'] } }],
  ['in over numbers', { rank: { in: [1, 10] } }],
  ['in over nothing', { label: { in: [] } }],
  ['notIn over strings', { label: { notIn: ['alpha'] } }],
  ['and of two leaves', { and: [{ flag: true }, { rank: { gt: 0 } }] }],
  ['or of two leaves', { or: [{ label: 'alpha' }, { label: 'beta' }] }],
  ['not of a leaf', { not: { flag: true } }],
  ['not of an or', { not: { or: [{ label: 'alpha' }, { label: 'beta' }] } }],
  ['nested and inside or', { or: [{ and: [{ flag: true }, { rank: { lt: 0 } }] }, { label: 'beta' }] }],
  ['or of one leaf', { or: [{ label: 'alpha' }] }],
  ['and of one leaf', { and: [{ label: 'alpha' }] }],
  ['and of nothing admits every row', { and: [] }],
  ['notIn while the field is null', { note: { notIn: ['hello world'] } }],
  ['gt while the field is null', { note: { gt: 'a' } }],
  ['not of a null equality', { not: { note: null } }],
  ['or with a null equality', { or: [{ note: null }, { label: 'beta' }] }]
];

describe('where expression compilation', () => {
  it.each(CASES)('agrees with the declared predicate: %s', (_name, where) => {
    expect(engineRows(where)).toEqual(predicateRows(where));
  });

  it('admits no row for a choice between nothing', () => {
    // The mirror of an empty `and`: a filter that offers no alternative is met by no row.
    expect(engineRows({ or: [] })).toEqual([]);
    expect(predicateRows({ or: [] })).toEqual([]);
  });

  it('matches every row when the filter carries no condition', () => {
    expect(engineRows({})).toEqual(ROWS.map(row => row.id).sort());
  });

  it('covers every declared comparison operator', () => {
    const declared = Object.keys(WHERE_OPERATOR_NAMES).sort();
    const exercised = [...new Set(CASES.flatMap(([, where]) => [...JSON.stringify(where).matchAll(/"(\w+)":/g)].map(match => match[1]!)).filter(name => declared.includes(name)))].sort();

    expect(exercised).toEqual(declared);
  });

  it('ignores a field whose value is undefined', () => {
    expect(engineRows({ label: undefined, flag: true })).toEqual(predicateRows({ label: undefined, flag: true }));
  });
});
