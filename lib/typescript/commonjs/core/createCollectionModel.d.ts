import type { CollectionModel, CreateCollectionModelConfig } from '../types';
/** Create a collection model from a persistent collection and normalizer. */
export declare function createCollectionModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}>(config: CreateCollectionModelConfig<TInput, TStored, TExt>): CollectionModel<TInput, TStored> & TExt;
//# sourceMappingURL=createCollectionModel.d.ts.map