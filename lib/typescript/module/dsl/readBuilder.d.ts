import type { DbWhere } from '../types';
export type ReadOrder<TStored> = {
    field: keyof TStored & string;
    direction: 'asc' | 'desc';
};
export type ModelReadBuilder<TStored extends {
    id: string;
}> = {
    /** Add one ordering key; later calls become deterministic tie-break keys before the implicit id key. */
    orderBy(field: keyof TStored & string, direction?: 'asc' | 'desc'): ModelReadBuilder<TStored>;
    /** Keep only the leading `count` rows after filtering and ordering. */
    limit(count: number): ModelReadBuilder<TStored>;
    /** Reactively read rows for this builder declaration. */
    rows(): TStored[];
    /** Read one non-reactive snapshot for this builder declaration. */
    read(): TStored[];
};
type ReadBuilderTerminals<TStored extends {
    id: string;
}> = {
    rows(where: DbWhere<TStored> | null, orders: ReadonlyArray<ReadOrder<TStored>>, limit: number | undefined): TStored[];
    read(where: DbWhere<TStored> | null, orders: ReadonlyArray<ReadOrder<TStored>>, limit: number | undefined): TStored[];
};
/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export declare const createReadBuilder: <TStored extends {
    id: string;
}>(where: DbWhere<TStored> | null, terminals: ReadBuilderTerminals<TStored>, orders?: ReadonlyArray<ReadOrder<TStored>>, count?: number | undefined) => ModelReadBuilder<TStored>;
export {};
//# sourceMappingURL=readBuilder.d.ts.map