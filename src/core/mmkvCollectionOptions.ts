import { BasicIndex, localStorageCollectionOptions } from '@tanstack/db';
import type { CollectionConfig, LocalStorageCollectionUtils } from '@tanstack/db';
import { getDbStorageAdapter } from './storage';

/** Build TanStack DB local-storage collection options backed by the configured storage adapter. */
export const mmkvCollectionOptions = <T extends object, TKey extends string | number = string>(config: {
  id: string;
  getKey: (item: T) => TKey;
}): CollectionConfig<T, TKey, never, LocalStorageCollectionUtils> & { id: string; utils: LocalStorageCollectionUtils; schema?: never } => {
  const storage = getDbStorageAdapter();
  return localStorageCollectionOptions({
    id: config.id,
    storageKey: `tanstack-db-${config.id}`,
    storage,
    storageEventApi: storage.eventApi,
    getKey: config.getKey,
    autoIndex: 'eager',
    defaultIndexType: BasicIndex
  });
};
