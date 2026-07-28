import type { ChangeMessage } from '@tanstack/db';
import type { EntityState } from './core.planes.entityState.types';

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
