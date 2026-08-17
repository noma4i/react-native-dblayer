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

const T = true;
const F = false;

/** Each filter names, per ROWS row, whether the declared language admits it: the literal is the contract for both surfaces. */
const FILTERS: Array<[string, DbWhere<Row> | undefined, boolean[]]> = [
  ['no condition', undefined, [T, T, T, T, T]],
  ['equality on a number', { a: 1 }, [T, F, F, F, F]],
  ['equality on null selects null, not the absent field', { a: null }, [F, F, T, F, F]],
  ['equality on a string', { b: 'y' }, [F, T, F, F, F]],
  ['gt', { a: { gt: 2 } }, [F, T, F, T, F]],
  ['gte', { a: { gte: 3 } }, [F, T, F, T, F]],
  ['lt', { a: { lt: 3 } }, [T, F, F, F, F]],
  ['lte', { a: { lte: 3 } }, [T, F, F, T, F]],
  ['in', { a: { in: [1, 5] } }, [T, T, F, F, F]],
  ['notIn admits null and the absent field', { a: { notIn: [1] } }, [F, T, T, T, T]],
  ['and', { and: [{ a: { gt: 0 } }, { b: 'x' }] }, [T, F, F, F, F]],
  ['or', { or: [{ a: 1 }, { b: 'z' }] }, [T, F, T, F, F]],
  ['not equality admits null and the absent field', { not: { a: 1 } }, [F, T, T, T, T]],
  ['not over and', { not: { and: [{ a: { gt: 0 } }] } }, [F, F, T, F, T]],
  ['not over or', { not: { or: [{ a: 1 }, { b: 'z' }] } }, [F, T, F, T, T]],
  ['not over in', { not: { a: { in: [1] } } }, [F, T, T, T, T]],
  ['nested not', { not: { not: { a: 1 } } }, [T, F, F, F, F]],
  ['empty and', { and: [] }, [T, T, T, T, T]],
  ['empty or', { or: [] }, [F, F, F, F, F]]
];

/**
 * One declared filter is read by two surfaces: a snapshot read walks the row itself, a live query
 * asks the collection engine. Both must reach the SAME literal answer per row, and the hard part is
 * that the engine follows SQL - a comparison against a missing value yields unknown, and unknown
 * negated stays unknown. The declared language has no unknown: a row whose field holds no value
 * simply is not equal to `1`, so `not` admits it.
 */
describe('filter language agreement', () => {
  it.each(FILTERS)('answers %s per row through the engine and the predicate', (_name, where, expected) => {
    expect(ROWS.map(row => engineAdmits(row, where))).toEqual(expected);
    expect(ROWS.map(row => matchesDbWhere(row, where))).toEqual(expected);
  });
});
