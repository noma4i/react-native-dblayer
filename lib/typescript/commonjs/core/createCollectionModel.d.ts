import type { CollectionModel, CreateCollectionModelFieldsConfig, CreateCollectionModelNormalizeConfig, FieldsCollectionModel, ModelBuildStoredInput, ModelFieldsInput, ModelFieldSpecs, ModelRelationsConfig, ModelStoredFromFields, RelatedSurface, RowRelatedSurface, StoredWriteInput } from '../types';
/**
 * Create a collection model from a persistent collection, normalizer, and relations.
 *
 * @param config Collection id, storage collection, normalize function, optional statics, freshness settings, sideloads, and lazy relations.
 * @returns A reactive collection model extended with supplied statics and relation accessors.
 */
export declare function createCollectionModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}, TRelations extends ModelRelationsConfig = any>(config: CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, TRelations> & {
    relations: () => TRelations;
}): CollectionModel<TInput, TStored & RowRelatedSurface<TRelations>> & TExt & RelatedSurface<TRelations>;
/**
 * Create a collection model from a persistent collection and normalizer.
 *
 * @param config Collection id, storage collection, normalize function, optional statics, freshness settings, and sideloads.
 * @returns A reactive collection model extended with supplied statics.
 */
export declare function createCollectionModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}>(config: Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, undefined>, 'relations'> & {
    relations?: undefined;
}): CollectionModel<TInput, TStored> & TExt;
/**
 * Create a fields-schema model with relation accessors and generated normalize/buildStored helpers.
 *
 * @param config Collection id, fields schema, optional rowId/guard/statics/freshness settings/sideloads, and lazy relations.
 * @returns A reactive fields collection model extended with supplied statics and relation accessors.
 */
export declare function createCollectionModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}, TRelations extends ModelRelationsConfig = any>(config: CreateCollectionModelFieldsConfig<TFields, TExt, TRelations> & {
    relations: () => TRelations;
}): FieldsCollectionModel<ModelStoredFromFields<TFields> & RowRelatedSurface<TRelations>, ModelBuildStoredInput<TFields>, ModelStoredFromFields<TFields>, ModelFieldsInput<TFields>> & TExt & RelatedSurface<TRelations>;
/**
 * Create a fields-schema model with generated normalize/buildStored helpers.
 *
 * @param config Collection id, fields schema, optional rowId/guard/statics/freshness settings, and sideloads.
 * @returns A reactive fields collection model extended with supplied statics.
 */
export declare function createCollectionModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}>(config: Omit<CreateCollectionModelFieldsConfig<TFields, TExt, undefined>, 'relations'> & {
    relations?: undefined;
}): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>, StoredWriteInput<ModelStoredFromFields<TFields>>, ModelFieldsInput<TFields>> & TExt;
//# sourceMappingURL=createCollectionModel.d.ts.map