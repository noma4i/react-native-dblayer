import type { CollectionModel, CreateCollectionModelConfig } from '../types';
/** Create a collection model from a persistent collection and normalizer. */
export declare function createCollectionModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}>(config: CreateCollectionModelConfig<TInput, TStored>): CollectionModel<TInput, TStored>;
//# sourceMappingURL=createCollectionModel.d.ts.map