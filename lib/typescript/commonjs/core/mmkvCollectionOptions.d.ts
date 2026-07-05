import type { CollectionConfig, LocalStorageCollectionUtils } from '@tanstack/db';
/** Build TanStack DB local-storage collection options backed by the configured storage adapter. */
export declare const mmkvCollectionOptions: <T extends object, TKey extends string | number = string>(config: {
    id: string;
    getKey: (item: T) => TKey;
}) => CollectionConfig<T, TKey, never, LocalStorageCollectionUtils> & {
    id: string;
    utils: LocalStorageCollectionUtils;
    schema?: never;
};
//# sourceMappingURL=mmkvCollectionOptions.d.ts.map