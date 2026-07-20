import type { DbWhere } from '../types';
import { hasRequiredFields } from '../read/requireFields';
import type { ProjectionOptions } from '../read/projectionGate';

export type ReadOrder<TStored> = { field: keyof TStored & string; direction: 'asc' | 'desc' };
export type RequiredFields<TStored, TFields extends keyof TStored> = TStored & { [K in TFields]-?: Exclude<TStored[K], undefined> };

export type ModelReadBuilder<TStored extends { id: string }, TOutput extends Record<string, unknown> = TStored> = {
  /** Add one ordering key; later calls become deterministic tie-break keys before the implicit id key. */
  orderBy(field: keyof TStored & string, direction?: 'asc' | 'desc'): ModelReadBuilder<TStored, TOutput>;
  /** Keep only the leading `count` rows after filtering and ordering. */
  limit(count: number): ModelReadBuilder<TStored, TOutput>;
  /**
   * Require stored fields before this row-level read returns a row. `undefined` means missing;
   * `null` is present. Scope reads intentionally have no equivalent because their totals remain
   * defined by unfiltered membership.
   */
  require<K extends keyof TStored & string>(...fields: K[]): ModelReadBuilder<RequiredFields<TStored, K>>;
  /** Project each reactive row with shallow value gating; selector identity is not a dependency. */
  select<TProjection extends Record<string, unknown>>(selector: (row: TStored) => TProjection): ModelReadBuilder<TStored, TProjection>;
  /** Reactively read rows for this builder declaration. Call `orderBy` for deterministic ordering; without it rows follow internal storage order. */
  rows(): TOutput[];
};

type ReadBuilderTerminals<TStored extends { id: string }> = {
  rows<TOutput extends Record<string, unknown>>(
    where: DbWhere<TStored> | null,
    orders: ReadonlyArray<ReadOrder<TStored>>,
    limit: number | undefined,
    required: readonly string[],
    projection: ProjectionOptions<TStored, TOutput>
  ): TOutput[];
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
  rows: () => terminals.rows(where, orders, count, required, projection)
});
