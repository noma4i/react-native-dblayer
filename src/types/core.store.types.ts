import type { ChangeMessage, ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';
import type { WriteCtx } from './core.writePolicies.types';

type UpsertResult = { changedFields: string[] | null };

/** Row read/write contract of the per-model primary store (implemented by `createModelStore`). */
export type EntityState<T extends { id: string }> = {
  read(id: string): T | undefined;
  values(): T[];
  /** Returns changed top-level fields vs the previous row, or null when the row is new. */
  upsert(row: T, options?: { mergeBase?: T; ctx?: WriteCtx }): UpsertResult;
  destroy(id: string, options?: { tombstone?: boolean }): void;
  /** Cache eviction (GC) - removes the row WITHOUT a tombstone; a later server row resurrects it. */
  evict(id: string): boolean;
  isTombstoned(id: string): boolean;
  pruneTombstones(): number;
  /** Serialize rows+tombstones into storage entries for the transaction's single persist batch. */
  persistEntries(): Array<{ key: string; value: string | null }>;
  ackPersist(): void;
  hydrate(): void;
  reset(): void;
};

/** One scope-projected row served by a live scope collection (entity fields plus orderKey). */
export type StoreScopeRow = { id?: string; orderKey: string };

export type StoreScopeChange = ChangeMessage<StoreScopeRow, string | number>;

export type StoreScopeCollection = {
  toArray(): StoreScopeRow[];
  subscribe(listener: (changes: StoreScopeChange[]) => void): () => void;
};

/** One scope membership row in the per-model membership collection. */
export type StoreMembershipRow = { scopeKey: string; entityId: string; orderKey: string };

/** The apply-target subset the store needs to project scope membership and order. */
export type StoreScopeSyncSource = {
  readScopeOrder(scopeKey: string): string[];
  scopeOrderAffected(scopeKey: string, id: string, fields: string[] | null): boolean;
};

export type StoreScopeSyncChange = {
  scopeKey: string;
  ids?: string[];
  appendIds?: string[];
  appendEntries?: Array<{ id: string; order: number }>;
  detachIds?: string[];
  rebuild?: boolean;
};

/**
 * Per-model primary store: the TanStack DB collection pair (entities + scope memberships) behind
 * the EntityState contract, plus the scope-projection surface consumed by reactive readers.
 */
export type ModelStore<T extends { id: string }> = EntityState<T> & {
  scopeCollection(scopeKey: string): StoreScopeCollection;
  replaceScope(scopeKey: string, entityIds: readonly string[]): void;
  applyScopeChanges(changes: readonly StoreScopeSyncChange[], rowChanges: ReadonlyArray<{ id: string; fields: string[] | null }>, source: StoreScopeSyncSource): void;
  markReady(): void;
  dispose(): void;
};

/** Collection sync-feed controls: transactional begin/write/commit plus readiness and truncate. */
export type StoreSyncMethods<T extends object> = {
  begin: () => void;
  write: (message: ChangeMessageOrDeleteKeyMessage<T, string>) => void;
  commit: () => void;
  markReady: () => void;
  truncate: () => void;
};

/** Tombstone marker for a destroyed row, stamped for age-based pruning. */
export type Tombstone = { at: number };
