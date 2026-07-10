import { createCollection, createTransaction } from '@tanstack/db';
import type {
  CollectionModel,
  CreateCollectionModelFieldsConfig,
  CreateCollectionModelNormalizeConfig,
  FieldsModelBase,
  FieldsCollectionModel,
  ModelBuildStoredInput,
  ModelExtension,
  ModelExtensionSurface,
  ModelFieldSpecs,
  ModelRelationsConfig,
  ModelStoredFromFields,
  NormalizedModelBase,
  PersistentCollection,
  PersistentMutationTransaction,
  RelatedSurface,
  RowRelatedSurface
} from '../types';
import { createCollectionModel } from './createCollectionModel';
import { getDbLogger } from './logger';
import { mmkvCollectionOptions } from './mmkvCollectionOptions';
import { clearAllCollections, registerPersistentCollectionMutationAcceptor } from './registry';

/**
 * Create a persistent TanStack DB collection backed by the configured storage adapter.
 * @param config Collection id used as the storage key prefix.
 * @returns Persistent collection adapter used by models.
 */
export const createPersistentCollection = <T extends { id: string }>(config: { id: string }): PersistentCollection<T> => {
  const collection = createCollection(
    mmkvCollectionOptions<T, string>({
      id: config.id,
      getKey: (item: T) => item.id
    })
  );

  collection.startSyncImmediate();
  const acceptMutations = (transaction: PersistentMutationTransaction): void => {
    collection.utils.acceptMutations(transaction as Parameters<typeof collection.utils.acceptMutations>[0]);
  };
  registerPersistentCollectionMutationAcceptor(config.id, acceptMutations);
  clearAllCollections.register(() => {
    const ids = [...collection.state.keys()];
    if (ids.length === 0) return;
    const tx = createTransaction({
      mutationFn: ({ transaction }) => {
        acceptMutations(transaction as PersistentMutationTransaction);
        return Promise.resolve();
      }
    });
    tx.mutate(() => {
      for (const id of ids) {
        collection.delete(id);
      }
    });
  });

  const tryUpdate = (id: string, updater: (draft: T) => void): boolean => {
    try {
      collection.update(id, draft => {
        updater(draft as T);
      });
      return true;
    } catch (error) {
      getDbLogger().error('[persistentCollection]', 'update failed', { id: config.id, key: id, error });
      return false;
    }
  };

  const tryDelete = (id: string): boolean => {
    try {
      collection.delete(id);
      return true;
    } catch (error) {
      getDbLogger().error('[persistentCollection]', 'delete failed', { id: config.id, key: id, error });
      return false;
    }
  };

  return {
    id: config.id,
    get: (id: string) => collection.state.get(id),
    has: (id: string) => collection.state.has(id),
    insert: (item: T) => {
      if (
        collection.state.has(item.id) &&
        tryUpdate(item.id, draft => {
          Object.assign(draft, item);
        })
      ) {
        return;
      }
      collection.insert(item);
    },
    update: (id: string, updater: (draft: T) => void) => {
      tryUpdate(id, updater);
    },
    delete: (id: string) => {
      tryDelete(id);
    },
    keys: () => collection.state.keys(),
    values: () => collection.state.values(),
    acceptMutations,
    get size() {
      return collection.state.size;
    },
    get _collection() {
      return collection;
    }
  };
};

type InferredModelExtensionsConfig<
  TConfig,
  TModel,
  TExtensions extends readonly ModelExtension<any, object>[],
  TStatics extends Record<string, unknown>
> = Omit<TConfig, 'extensions' | 'statics'> & {
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
export function defineModel<
  TInput,
  TStored extends { id: string; updatedAt?: string | null },
  TRelations extends ModelRelationsConfig,
  const TExtensions extends readonly ModelExtension<any, object>[],
  TStatics extends Record<string, unknown> = {}
>(
  config: InferredModelExtensionsConfig<
    Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, {}, TRelations>, 'collection' | 'normalize'> & {
      id: string;
      normalize: (item: TInput) => (Partial<TStored> & { id: string }) | null;
      relations: () => TRelations;
    },
    NormalizedModelBase<TInput, TStored, TRelations>,
    TExtensions,
    TStatics
  >
): CollectionModel<TInput, TStored & RowRelatedSurface<TRelations>> & ModelExtensionSurface<TExtensions> & TStatics & RelatedSurface<TRelations>;
export function defineModel<
  TInput,
  TStored extends { id: string; updatedAt?: string | null },
  const TExtensions extends readonly ModelExtension<any, object>[],
  TStatics extends Record<string, unknown> = {}
>(
  config: InferredModelExtensionsConfig<
    Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, {}, undefined>, 'collection' | 'normalize' | 'relations'> & {
      id: string;
      normalize: (item: TInput) => (Partial<TStored> & { id: string }) | null;
      relations?: undefined;
    },
    NormalizedModelBase<TInput, TStored, undefined>,
    TExtensions,
    TStatics
  >
): CollectionModel<TInput, TStored> & ModelExtensionSurface<TExtensions> & TStatics;
export function defineModel<
  TFields extends ModelFieldSpecs,
  TRelations extends ModelRelationsConfig,
  const TExtensions extends readonly ModelExtension<any, object>[],
  TStatics extends Record<string, unknown> = {}
>(
  config: InferredModelExtensionsConfig<
    Omit<CreateCollectionModelFieldsConfig<TFields, {}, TRelations>, 'collection' | 'fields'> & {
      id: string;
      fields: TFields;
      relations: () => TRelations;
    },
    FieldsModelBase<TFields, TRelations>,
    TExtensions,
    TStatics
  >
): FieldsCollectionModel<ModelStoredFromFields<TFields> & RowRelatedSurface<TRelations>, ModelBuildStoredInput<TFields>, ModelStoredFromFields<TFields>> &
  ModelExtensionSurface<TExtensions> &
  TStatics &
  RelatedSurface<TRelations>;
export function defineModel<
  TFields extends ModelFieldSpecs,
  const TExtensions extends readonly ModelExtension<any, object>[],
  TStatics extends Record<string, unknown> = {}
>(
  config: InferredModelExtensionsConfig<
    Omit<CreateCollectionModelFieldsConfig<TFields, {}, undefined>, 'collection' | 'fields' | 'relations'> & {
      id: string;
      fields: TFields;
      relations?: undefined;
    },
    FieldsModelBase<TFields, undefined>,
    TExtensions,
    TStatics
  >
): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>> & ModelExtensionSurface<TExtensions> & TStatics;
export function defineModel<
  TInput,
  TStored extends { id: string; updatedAt?: string | null },
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig = any
>(
  config: Omit<Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, TRelations>, 'collection'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations: () => TRelations;
    extensions?: undefined;
  }
): CollectionModel<TInput, TStored & RowRelatedSurface<TRelations>> & TExt & RelatedSurface<TRelations>;
export function defineModel<TInput, TStored extends { id: string; updatedAt?: string | null }, TExt extends Record<string, unknown> = {}>(
  config: Omit<Omit<Omit<CreateCollectionModelNormalizeConfig<TInput, TStored, TExt, undefined>, 'collection'>, 'relations'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations?: undefined;
    extensions?: undefined;
  }
): CollectionModel<TInput, TStored> & TExt;
export function defineModel<
  TFields extends ModelFieldSpecs,
  TExt extends Record<string, unknown> = {},
  TRelations extends ModelRelationsConfig = any
>(
  config: Omit<Omit<CreateCollectionModelFieldsConfig<TFields, TExt, TRelations>, 'collection'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations: () => TRelations;
    extensions?: undefined;
  }
): FieldsCollectionModel<ModelStoredFromFields<TFields> & RowRelatedSurface<TRelations>, ModelBuildStoredInput<TFields>, ModelStoredFromFields<TFields>> & TExt & RelatedSurface<TRelations>;
export function defineModel<TFields extends ModelFieldSpecs, TExt extends Record<string, unknown> = {}>(
  config: Omit<Omit<Omit<CreateCollectionModelFieldsConfig<TFields, TExt, undefined>, 'collection'>, 'relations'>, 'extensions'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
    relations?: undefined;
    extensions?: undefined;
  }
): FieldsCollectionModel<ModelStoredFromFields<TFields>, ModelBuildStoredInput<TFields>> & TExt;
export function defineModel(
  config: (
    | Omit<CreateCollectionModelNormalizeConfig<any, any, any, any>, 'collection'>
    | Omit<CreateCollectionModelNormalizeConfig<any, any, any, undefined>, 'collection'>
    | Omit<CreateCollectionModelFieldsConfig<any, any, any>, 'collection'>
    | Omit<CreateCollectionModelFieldsConfig<any, any, undefined>, 'collection'>
  ) & {
    id: string;
  }
): any {
  const { id, ...modelConfig } = config;
  return createCollectionModel({
    ...modelConfig,
    collection: createPersistentCollection<any>({ id })
  } as any);
}
