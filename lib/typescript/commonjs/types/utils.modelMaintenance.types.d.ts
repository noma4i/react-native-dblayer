import type { RowId } from './utils.singletonStatics.types';
import type { CreatedAtRow } from './utils.optimisticReconcile.types';
/** Minimal model surface for bulk destroy maintenance. */
export type DestroyManyModel<TStored extends RowId> = {
    all(): TStored[];
    destroyMany(ids: string[]): void;
};
/** Rows protected from a maintenance sweep: predicate, id set, or id list. */
export type RowProtect<TStored extends RowId> = ((row: TStored) => boolean) | ReadonlySet<string> | readonly string[];
/** `resolveStaleTempRows` options: age cutoff, protected ids, and the stale-row callback. */
export type ResolveStaleTempRowsOptions<TStored extends CreatedAtRow> = {
    maxAgeMs: number;
    protectedIds?: ReadonlySet<string> | readonly string[];
    onStale: (row: TStored) => void;
};
//# sourceMappingURL=utils.modelMaintenance.types.d.ts.map