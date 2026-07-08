import type { CollectionModel, CreateCollectionModelFieldsConfig, CreateCollectionModelNormalizeConfig, FieldsCollectionModel, ModelBuildStoredInput, ModelFieldSpecs, ModelRelationsConfig, ModelStoredFromFields, RelatedSurface, RowRelatedSurface } from '../types';
export declare function createCollectionModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}, TRelations extends ModelRelationsConfig = any>(config: CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, TRelations> & {
    relations: () => TRelations;
}): CollectionModel<TInput, TStored & RowRelatedSurface<TRelations>> & TExt & RelatedSurface<TRelations>;
/** Create a collection model from a persistent collection and normalizer. */
export declare function createCollectionModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}>(config: Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, TExt>, 'relations'> & {
    relations?: undefined;
}): CollectionModel<TInput, TStored> & TExt;
export declare function createCollectionModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}, TRelations extends ModelRelationsConfig = any>(config: CreateCollectionModelFieldsConfig<TFields, TExt, TRelations> & {
    relations: () => TRelations;
}): FieldsCollectionModel<ModelStoredFromFields<TFields> & RowRelatedSurface<TRelations>, ModelBuildStoredInput<TFields>, ModelStoredFromFields<TFields>> & TExt & RelatedSurface<TRelations>;
export declare function createCollectionModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}>(config: Omit<CreateCollectionModelFieldsConfig<TFields, TExt>, 'relations'> & {
    relations?: undefined;
}): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>> & TExt;
//# sourceMappingURL=createCollectionModel.d.ts.map