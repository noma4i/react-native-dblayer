import type { DbWhere, ModelReadBuilder, ProjectionOptions, ReadBuilderTerminals, ReadOrder } from '../types';
/** Create a plain immutable read builder whose terminals delegate to the model read engine. */
export declare const createReadBuilder: <TStored extends {
    id: string;
}>(where: DbWhere<TStored> | null, terminals: ReadBuilderTerminals<TStored>, orders?: ReadonlyArray<ReadOrder<TStored>>, count?: number | undefined, required?: readonly string[], projection?: ProjectionOptions<TStored, TStored>) => ModelReadBuilder<TStored>;
//# sourceMappingURL=readBuilder.d.ts.map