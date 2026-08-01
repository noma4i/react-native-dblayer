import { IR, compileSingleRowExpression, toBooleanPredicate } from '@tanstack/db';
import { compileWhereExpression, matchesDbWhere } from '../../testApi';
import type { DbWhere } from '../../testApi';

type Row = Record<string, unknown>;

/** Reference a row's fields the way the query builder does, but for one row rather than a namespace. */
const refFor = (fields: readonly string[]) => Object.fromEntries(fields.map(field => [field, new IR.PropRef([field])])) as never;

const engineAdmits = (row: Row, where: DbWhere<Row> | undefined): boolean =>
  toBooleanPredicate(compileSingleRowExpression(compileWhereExpression(refFor(Object.keys(row)), where) as never)(row));

const ROWS: Row[] = [
  { a: 1, b: 'x' },
  { a: 5, b: 'y' },
  { a: null, b: 'z' },
  { a: 3, b: null },
  { a: undefined, b: 'w' }
];

const FILTERS: Array<[string, DbWhere<Row> | undefined]> = [
  ['no condition', undefined],
  ['equality on a number', { a: 1 }],
  ['equality on null', { a: null }],
  ['equality on a string', { b: 'y' }],
  ['gt', { a: { gt: 2 } }],
  ['gte', { a: { gte: 3 } }],
  ['lt', { a: { lt: 3 } }],
  ['lte', { a: { lte: 3 } }],
  ['in', { a: { in: [1, 5] } }],
  ['notIn', { a: { notIn: [1] } }],
  ['and', { and: [{ a: { gt: 0 } }, { b: 'x' }] }],
  ['or', { or: [{ a: 1 }, { b: 'z' }] }],
  ['not equality', { not: { a: 1 } }],
  ['not over and', { not: { and: [{ a: { gt: 0 } }] } }],
  ['not over or', { not: { or: [{ a: 1 }, { b: 'z' }] } }],
  ['not over in', { not: { a: { in: [1] } } }],
  ['nested not', { not: { not: { a: 1 } } }],
  ['empty and', { and: [] }],
  ['empty or', { or: [] }]
];

/**
 * One declared filter is read by two surfaces: a snapshot read walks the row itself, a live query
 * asks the collection engine. They must return the same rows, and the hard part is that the engine
 * follows SQL - a comparison against a missing value yields unknown, and unknown negated stays
 * unknown. The declared language has no unknown: a row whose field holds no value simply is not
 * equal to `1`, so `not` admits it. Every case below is one filter asked of both surfaces.
 */
describe('filter language agreement', () => {
  it.each(FILTERS)('answers %s the same row by row and through the engine', (_name, where) => {
    expect(ROWS.map(row => engineAdmits(row, where))).toEqual(ROWS.map(row => matchesDbWhere(row, where)));
  });
});
