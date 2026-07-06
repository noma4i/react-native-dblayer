import type { CollectionModel, CreateCollectionModelConfig, PersistentCollection } from '../types';
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
export declare const defineModel: <TInput, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TExt extends Record<string, unknown> = {}>(config: Omit<CreateCollectionModelConfig<TInput, TStored, TExt>, "collection"> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
}) => CollectionModel<TInput, TStored> & TExt;
//# sourceMappingURL=createPersistentCollection.d.ts.map