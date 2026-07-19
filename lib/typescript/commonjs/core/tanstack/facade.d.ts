import { createLiveQueryCollection, eq, type Collection, type SyncConfig } from '@tanstack/db';
/** Creates a TanStack live query collection for internal data-layer projections. */
export { createLiveQueryCollection };
/** Builds an equality predicate for internal TanStack live query joins and filters. */
export { eq };
/** A stored row accepted by the TanStack collection facade. */
export type StoredRowShape = {
  id: string;
} & Record<string, unknown>;
/** One ordered scope membership row stored in a TanStack collection. */
export type MembershipRow = {
  key: string;
  scopeKey: string;
  rowId: string;
  seq?: number;
  sortValue?: unknown;
};
/** The synchronous writer callbacks supplied by a TanStack collection sync adapter. */
export type CollectionWriter<TRow extends object = StoredRowShape> = Pick<Parameters<SyncConfig<TRow, string>[`sync`]>[0], `begin` | `write` | `commit` | `markReady`>;
/** Registers the shared scope-live-read registry cleanup used by collection reset. */
export declare function registerLiveScopeReadReset(reset: () => void): void;
/** Creates an empty, ready TanStack collection for a model identifier. */
export declare function createModelCollection(
  modelId: string
): Collection<StoredRowShape, string, import('@tanstack/db').UtilsRecord, never, StoredRowShape> & import('@tanstack/db').NonSingleResult;
/** Returns a model collection, creating its ready writer-backed instance when absent. */
export declare function ensureModelCollection(modelId: string): Collection<StoredRowShape, string>;
/** Returns a model membership collection, creating its ready writer-backed instance when absent. */
export declare function ensureMembershipCollection(
  modelId: string
): Collection<MembershipRow, string, import('@tanstack/db').UtilsRecord, import('@standard-schema/spec').StandardSchemaV1<unknown, unknown>, MembershipRow>;
/** Returns the registered synchronous writer for a model identifier. */
export declare function writerFor(modelId: string): CollectionWriter;
/** Returns the registered synchronous membership writer for a model identifier. */
export declare function membershipWriterFor(modelId: string): CollectionWriter<MembershipRow>;
/** Reports whether a synchronous writer is registered for a model identifier. */
export declare function hasWriter(modelId: string): boolean;
/** Clears the TanStack collection and writer registries. */
export declare function resetCollectionRegistry(): void;
/** Runs synchronous writes in one TanStack cross-collection transaction context. */
export declare function runInWriteBatch<T>(fn: () => T): T;
/** Returns the registered TanStack collection for a model identifier. */
export declare function collectionFor(
  modelId: string
): Collection<StoredRowShape, string, import('@tanstack/db').UtilsRecord, import('@standard-schema/spec').StandardSchemaV1<unknown, unknown>, StoredRowShape>;
/** Returns the registered membership collection for a model identifier. */
export declare function membershipCollectionFor(
  modelId: string
): Collection<MembershipRow, string, import('@tanstack/db').UtilsRecord, import('@standard-schema/spec').StandardSchemaV1<unknown, unknown>, MembershipRow>;
//# sourceMappingURL=facade.d.ts.map
