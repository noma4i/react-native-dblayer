import { createCollection, createTransaction, type Collection, type SyncConfig } from '@tanstack/db';

/** A stored row accepted by the TanStack collection facade. */
export type StoredRowShape = { id: string } & Record<string, unknown>;

/** One ordered scope membership row stored in a TanStack collection. */
export type MembershipRow = {
  key: string;
  scopeKey: string;
  rowId: string;
  seq?: number;
  sortValue?: unknown;
};

/** The synchronous writer callbacks supplied by a TanStack collection sync adapter. */
export type CollectionWriter = Pick<Parameters<SyncConfig<any, string>[`sync`]>[0], `begin` | `write` | `commit` | `markReady`>;

const writerRegistry = new Map<string, CollectionWriter>();
const collectionRegistry = new Map<string, Collection<any, string>>();

/** Creates an empty, ready TanStack collection for a model identifier. */
export function createModelCollection(modelId: string) {
  const collection = createCollection<StoredRowShape, string>({
    id: modelId,
    getKey: row => row.id,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        writerRegistry.set(modelId, { begin, write, commit, markReady });
        begin();
        commit();
        markReady();
      }
    }
  });

  collectionRegistry.set(modelId, collection);
  return collection;
}

/** Returns a model collection, creating its ready writer-backed instance when absent. */
export function ensureModelCollection(modelId: string) {
  return collectionRegistry.get(modelId) ?? createModelCollection(modelId);
}

/** Returns a model membership collection, creating its ready writer-backed instance when absent. */
export function ensureMembershipCollection(modelId: string) {
  const id = `${modelId}::membership`;
  const existing = collectionRegistry.get(id);
  if (existing) return existing as unknown as Collection<MembershipRow, string>;
  const collection = createCollection<MembershipRow, string>({
    id,
    getKey: row => row.key,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        writerRegistry.set(id, { begin, write, commit, markReady });
        begin();
        commit();
        markReady();
      }
    }
  });
  collectionRegistry.set(id, collection);
  return collection;
}

/** Returns the registered synchronous writer for a model identifier. */
export function writerFor(modelId: string): CollectionWriter {
  const writer = writerRegistry.get(modelId);
  if (!writer) {
    throw new Error(`Missing writer for ${modelId}`);
  }
  return writer;
}

/** Returns the registered synchronous membership writer for a model identifier. */
export function membershipWriterFor(modelId: string): CollectionWriter {
  return writerFor(`${modelId}::membership`);
}

/** Reports whether a synchronous writer is registered for a model identifier. */
export function hasWriter(modelId: string): boolean {
  return writerRegistry.has(modelId);
}

/** Clears the TanStack collection and writer registries. */
export function resetCollectionRegistry(): void {
  writerRegistry.clear();
  collectionRegistry.clear();
}

/** Runs synchronous writes in one TanStack cross-collection transaction context. */
export function runInWriteBatch<T>(fn: () => T): T {
  let result: T | undefined;
  const transaction = createTransaction({
    mutationFn: async () => undefined
  });

  transaction.mutate(() => {
    result = fn();
  });

  return result as T;
}

/** Returns the registered TanStack collection for a model identifier. */
export function collectionFor(modelId: string) {
  const collection = collectionRegistry.get(modelId);
  if (!collection) {
    throw new Error(`Missing collection for ${modelId}`);
  }
  return collection;
}

/** Returns the registered membership collection for a model identifier. */
export function membershipCollectionFor(modelId: string) {
  const collection = collectionRegistry.get(`${modelId}::membership`);
  if (!collection) throw new Error(`Missing membership collection for ${modelId}`);
  return collection as unknown as Collection<MembershipRow, string>;
}
