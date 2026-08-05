/**
 * Server-cache storage namespaces: losing them is eviction, never user-data loss. The composite
 * key builder accepts ONLY these, so a durable key (`ops`, `ops-once`, `quarantine`) cannot be
 * built - and therefore cannot be wiped - through the cache-key surface.
 */
export type CacheNamespace = 'row' | 'scope' | 'tombstones' | 'query' | 'query-invalidation';

export type QueryInvalidationRecord = {
  recordVersion: 1;
  revision: number;
  identities: Record<string, number>;
};

export type StorageResetEntry = { key: string; value: string };

export type StorageResetIntent = {
  recordVersion: 1;
  restore: StorageResetEntry[];
};
