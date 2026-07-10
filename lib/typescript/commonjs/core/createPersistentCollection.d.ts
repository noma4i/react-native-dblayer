import type { CollectionModel, CreateCollectionModelFieldsConfig, CreateCollectionModelNormalizeConfig, FieldsModelBase, FieldsCollectionModel, ModelBuildStoredInput, ModelExtension, ModelExtensionSurface, ModelFieldSpecs, ModelFieldsInput, ModelRelationsConfig, ModelStoredFromFields, NormalizedModelBase, PersistentCollection, RelatedSurface, RowRelatedSurface, StoredWriteInput } from '../types';
/**
 * Create a persistent TanStack DB collection backed by the configured storage adapter.
 * @param config Collection id used as the storage key prefix.
 * @returns Persistent collection adapter used by models.
 */
export declare const createPersistentCollection: <T extends {
    id: string;
}>(config: {
    id: string;
}) => PersistentCollection<T>;
type InferredModelExtensionsConfig<TConfig, TModel, TExtensions extends readonly ModelExtension<any, object>[], TStatics extends Record<string, unknown>> = Omit<TConfig, 'extensions' | 'statics'> & {
    extensions: TExtensions & ReadonlyArray<ModelExtension<TModel, object>>;
    statics?: (model: TModel) => TStatics;
};
/**
 * Define a persistent, reactive model with a normalizer.
 * @param config Model id, name, normalizer, freshness, merge, replace, and sort options.
 * @returns Collection model for snapshot reads, reactive hooks, and writes.
 *
 * @example
 * const UserModel = defineModel<UserInput, User>({
 *   id: 'users',
 *   name: 'UserModel',
 *   normalize: user => ({ id: user.id, name: user.name, updatedAt: user.updatedAt })
 * });
 */
export declare function defineModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TRelations extends ModelRelationsConfig, const TExtensions extends readonly ModelExtension<any, object>[], TStatics extends Record<string, unknown> = {}>(config: InferredModelExtensionsConfig<Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, {}, TRelations>, 'collection' | 'normalize'> & {
    id: string;
    normalize: (item: TInput) => (Partial<TStored> & {
        id: string;
    }) | null;
    relations: () => TRelations;
}, NormalizedModelBase<TInput, TStored, TRelations>, TExtensions, TStatics>): CollectionModel<TInput, TStored & RowRelatedSurface<TRelations>> & ModelExtensionSurface<TExtensions> & TStatics & RelatedSurface<TRelations>;
export declare function defineModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, const TExtensions extends readonly ModelExtension<any, object>[], TStatics extends Record<string, unknown> = {}>(config: InferredModelExtensionsConfig<Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, {}, undefined>, 'collection' | 'normalize' | 'relations'> & {
    id: string;
    normalize: (item: TInput) => (Partial<TStored> & {
        id: string;
    }) | null;
    relations?: undefined;
}, NormalizedModelBase<TInput, TStored, undefined>, TExtensions, TStatics>): CollectionModel<TInput, TStored> & ModelExtensionSurface<TExtensions> & TStatics;
export declare function defineModel<TFields extends ModelFieldSpecs, TRelations extends ModelRelationsConfig, const TExtensions extends readonly ModelExtension<any, object>[], TStatics extends Record<string, unknown> = {}>(config: InferredModelExtensionsConfig<Omit<CreateCollectionModelFieldsConfig<TFields, {}, TRelations>, 'collection' | 'fields'> & {
    id: string;
    fields: TFields;
    relations: () => TRelations;
}, FieldsModelBase<TFields, TRelations>, TExtensions, TStatics>): FieldsCollectionModel<ModelStoredFromFields<TFields> & RowRelatedSurface<TRelations>, ModelBuildStoredInput<TFields>, ModelStoredFromFields<TFields>, ModelFieldsInput<TFields>> & ModelExtensionSurface<TExtensions> & TStatics & RelatedSurface<TRelations>;
export declare function defineModel<TFields extends ModelFieldSpecs, const TExtensions extends readonly ModelExtension<any, object>[], TStatics extends Record<string, unknown> = {}>(config: InferredModelExtensionsConfig<Omit<CreateCollectionModelFieldsConfig<TFields, {}, undefined>, 'collection' | 'fields' | 'relations'> & {
    id: string;
    fields: TFields;
    relations?: undefined;
}, FieldsModelBase<TFields, undefined>, TExtensions, TStatics>): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>, StoredWriteInput<ModelStoredFromFields<TFields>>, ModelFieldsInput<TFields>> & ModelExtensionSurface<TExtensions> & TStatics;
export declare function defineModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}, TRelations extends ModelRelationsConfig = any>(config: Omit<Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, TRelations>, 'collection'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations: () => TRelations;
    extensions?: undefined;
}): CollectionModel<TInput, TStored & RowRelatedSurface<TRelations>> & TExt & RelatedSurface<TRelations>;
export declare function defineModel<TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}>(config: Omit<Omit<Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, undefined>, 'collection'>, 'relations'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations?: undefined;
    extensions?: undefined;
}): CollectionModel<TInput, TStored> & TExt;
export declare function defineModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}, TRelations extends ModelRelationsConfig = any>(config: Omit<Omit<CreateCollectionModelFieldsConfig<TFields, TExt, TRelations>, 'collection'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations: () => TRelations;
    extensions?: undefined;
}): FieldsCollectionModel<ModelStoredFromFields<TFields> & RowRelatedSurface<TRelations>, ModelBuildStoredInput<TFields>, ModelStoredFromFields<TFields>, ModelFieldsInput<TFields>> & TExt & RelatedSurface<TRelations>;
export declare function defineModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}>(config: Omit<Omit<Omit<CreateCollectionModelFieldsConfig<TFields, TExt, undefined>, 'collection'>, 'relations'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations?: undefined;
    extensions?: undefined;
}): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>, StoredWriteInput<ModelStoredFromFields<TFields>>, ModelFieldsInput<TFields>> & TExt;
export {};
//# sourceMappingURL=createPersistentCollection.d.ts.map