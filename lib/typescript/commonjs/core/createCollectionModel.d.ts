import type { CollectionModel, CreateCollectionModelFieldsConfig, CreateCollectionModelNormalizeConfig, FieldsCollectionModel, ModelBuildStoredInput, ModelFieldSpecs, ModelStoredFromFields } from '../types';
/** Create a collection model from a persistent collection and normalizer. */
export declare function createCollectionModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}>(config: CreateCollectionModelNormalizeConfig<TInput, TStored, TExt>): CollectionModel<TInput, TStored> & TExt;
export declare function createCollectionModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}>(config: CreateCollectionModelFieldsConfig<TFields, TExt>): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>> & TExt;
//# sourceMappingURL=createCollectionModel.d.ts.map