"use strict";

import { BasicIndex, localStorageCollectionOptions } from '@tanstack/db';
import { getDbStorageAdapter } from "./storage.js";

/** Build TanStack DB local-storage collection options backed by the configured storage adapter. */
export const mmkvCollectionOptions = config => {
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
//# sourceMappingURL=mmkvCollectionOptions.js.map