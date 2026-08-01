import type { Collection } from '@tanstack/db';
import type { DbWhere, RowRecord } from './db.types';
/** Declared model read: filter, order keys, row limit and the fields a row must carry to be served. */
export type ModelQuerySpec<TStored extends RowRecord> = {
    where: DbWhere<TStored> | undefined;
    orderBy: ReadonlyArray<{
        field: string;
        direction: 'asc' | 'desc';
    }>;
    limit: number | undefined;
    required: readonly string[];
};
/** One held model query: current rows, a change subscription, and the reference the reader gives back. */
export type ModelQueryHandle = {
    rows(): RowRecord[];
    subscribe(listener: () => void): () => void;
    release(): void;
};
export type ModelQueryPlane = {
    query<TStored extends RowRecord>(key: string, spec: ModelQuerySpec<TStored>): ModelQueryHandle;
    dispose(): void;
};
export type ModelQueryPlaneOptions = {
    modelId: string;
    storeId: number;
    entities: Collection<RowRecord>;
};
//# sourceMappingURL=core.modelQueries.types.d.ts.map