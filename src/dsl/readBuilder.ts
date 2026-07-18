import type { DbWhere } from '../types';
import { hasRequiredFields } from '../read/requireFields';

export type ReadOrder<TStored> = { field: keyof TStored & string; direction: 'asc' | 'desc' };
export type RequiredFields<TStored, TFields extends keyof TStored> = TStored & { [K in TFields]-?: Exclude<TStored[K], undefined> };

export type ModelReadBuilder<TStored extends { id: string }> = {
  /** Add one ordering key; later calls become deterministic tie-break keys before the implicit id key. */
  orderBy(field: keyof TStored & string, direction?: 'asc' | 'desc'): ModelReadBuilder<TStored>;
  /** Keep only the leading `count` rows after filtering and ordering. */
  limit(count: number): ModelReadBuilder<TStored>;
  /**
   * Require stored fields before this row-level read returns a row. `undefined` means missing;
   * `null` is present. Scope reads intentionally have no equivalent because their totals remain
   * defined by unfiltered membership.
   */
  require<K extends keyof TStored & string>(...fields: K[]): ModelReadBuilder<RequiredFields<TStored, K>>;
  /** Reactively read rows for this builder declaration. Call `orderBy` for deterministic ordering; without it rows follow internal storage order. */
  rows(): TStored[];
  /** Read one non-reactive snapshot for this builder declaration. Call `orderBy` for deterministic ordering; without it rows follow internal storage order. */
  read(): TStored[];
};

type ReadBuilderTerminals<TStored extends { id: string }> = {
  rows(where: DbWhere<TStored> | null, orders: ReadonlyArray<ReadOrder<TStored>>, limit: number | undefined, required: readonly string[]): TStored[];
  read(where: DbWhere<TStored> | null, orders: ReadonlyArray<ReadOrder<TStored>>, limit: number | undefined, required: readonly string[]): TStored[];
};

/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export const createReadBuilder = <TStored extends { id: string }>(
  where: DbWhere<TStored> | null,
  terminals: ReadBuilderTerminals<TStored>,
  orders: ReadonlyArray<ReadOrder<TStored>> = [],
  count: number | undefined = undefined,
  required: readonly string[] = []
): ModelReadBuilder<TStored> => ({
  orderBy: (field, direction = 'asc') => createReadBuilder(where, terminals, [...orders, { field, direction }], count, required),
  limit: nextCount => createReadBuilder(where, terminals, orders, nextCount, required),
  require: (...fields) => createReadBuilder(where, terminals, orders, count, [...required, ...fields]) as never,
  rows: () => terminals.rows(where, orders, count, required),
  read: () => terminals.read(where, orders, count, required)
});
