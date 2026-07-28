import type { DbWhere , ModelReadBuilder, ProjectionOptions, ReadOrder } from '../types';

type ReadBuilderTerminals<TStored extends { id: string }> = {
  rows<TOutput extends Record<string, unknown>>(
    where: DbWhere<TStored> | null,
    orders: ReadonlyArray<ReadOrder<TStored>>,
    limit: number | undefined,
    required: readonly string[],
    projection: ProjectionOptions<TStored, TOutput>
  ): TOutput[];
  pluck(
    where: DbWhere<TStored> | null,
    orders: ReadonlyArray<ReadOrder<TStored>>,
    limit: number | undefined,
    required: readonly string[],
    projection: ProjectionOptions<TStored, Record<string, unknown>>,
    field: string
  ): unknown[];
  exists(where: DbWhere<TStored> | null, required: readonly string[]): boolean;
};

/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export const createReadBuilder = <TStored extends { id: string }>(
  where: DbWhere<TStored> | null,
  terminals: ReadBuilderTerminals<TStored>,
  orders: ReadonlyArray<ReadOrder<TStored>> = [],
  count: number | undefined = undefined,
  required: readonly string[] = [],
  projection: ProjectionOptions<TStored, TStored> = {}
): ModelReadBuilder<TStored> => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, { field, direction }], count, required, projection),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount, required, projection),
  require: (...fields) => createReadBuilder(where, terminals, orders, count, [...required, ...fields], projection) as never,
  select: selector => createReadBuilder(where, terminals, orders, count, required, { select: selector } as never) as never,
  rows: () => terminals.rows(where, orders, count, required, projection),
  last: () => {
    const rows = terminals.rows(where, orders, count, required, projection);
    return rows[rows.length - 1];
  },
  pluck: field => terminals.pluck(where, orders, count, required, projection as ProjectionOptions<TStored, Record<string, unknown>>, field) as never,
  exists: () => terminals.exists(where, required)
});
