import type { DbWhere, ModelReadBuilder, ProjectionOptions, ReadOrder } from '../types';
type ReadBuilderTerminals<TStored extends {
    id: string;
}> = {
    rows<TOutput extends Record<string, unknown>>(where: DbWhere<TStored> | null, orders: ReadonlyArray<ReadOrder<TStored>>, limit: number | undefined, required: readonly string[], projection: ProjectionOptions<TStored, TOutput>): TOutput[];
    pluck(where: DbWhere<TStored> | null, orders: ReadonlyArray<ReadOrder<TStored>>, limit: number | undefined, required: readonly string[], projection: ProjectionOptions<TStored, Record<string, unknown>>, field: string): unknown[];
    exists(where: DbWhere<TStored> | null, required: readonly string[]): boolean;
};
/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export declare const createReadBuilder: <TStored extends {
    id: string;
}>(where: DbWhere<TStored> | null, terminals: ReadBuilderTerminals<TStored>, orders?: ReadonlyArray<ReadOrder<TStored>>, count?: number | undefined, required?: readonly string[], projection?: ProjectionOptions<TStored, TStored>) => ModelReadBuilder<TStored>;
export {};
//# sourceMappingURL=readBuilder.d.ts.map