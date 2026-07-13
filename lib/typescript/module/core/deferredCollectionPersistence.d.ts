import type { BaseCollectionConfig, CollectionConfig, LocalStorageCollectionUtils, StorageApi, StorageEventApi } from '@tanstack/db';
type Parser = {
    parse: (data: string) => unknown;
    stringify: (data: unknown) => string;
};
type DeferredCollectionPersistenceConfig<T extends object, TKey extends string | number> = BaseCollectionConfig<T, TKey, never, LocalStorageCollectionUtils> & {
    storageKey: string;
    storage: StorageApi;
    storageEventApi: StorageEventApi;
    parser?: Parser;
};
/** Build collection options that defer only whole-collection storage serialization. */
export declare const deferredCollectionPersistence: <T extends object, TKey extends string | number = string>(config: DeferredCollectionPersistenceConfig<T, TKey>) => CollectionConfig<T, TKey, never, LocalStorageCollectionUtils> & {
    id: string;
    utils: LocalStorageCollectionUtils;
    schema?: never;
};
export {};
//# sourceMappingURL=deferredCollectionPersistence.d.ts.map