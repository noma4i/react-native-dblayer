import type { QueryKey } from '@tanstack/react-query';
import type { IncrementalCommitBatch , ActiveFetchReader, MaterializationReconciler } from '../../types';
import { getCommitBus, getDbQueryClient, isDbConfigured } from '../../dsl/configure';
import { registerReset } from '../reset';
import { stableSerialize } from '../serialize';

const readers = new Set<ActiveFetchReader>();
registerReset(() => readers.clear());
const serializedKeyOf = (queryKey: QueryKey): string => stableSerialize(queryKey);

/**
 * Committed materialization feed. Freshness is only valid while the applied result is still
 * materialized, and a chain loses an id for one reason with two shapes: the row was destroyed, or
 * the row survived but left the destination scope (complete-coverage snapshot, retention trim). Both
 * reach the reader as a touched scope - `applyExecution` records the
 * reactive scopes of destroyed rows alongside scope writes - so one feed covers the invariant.
 * Each registered query prunes what it no longer materializes and goes stale once nothing is left.
 */
const reconcilers = new Set<MaterializationReconciler>();
registerReset(() => reconcilers.clear());

const noteLostMaterialization = (batch: IncrementalCommitBatch): void => {
  if (!isDbConfigured() || reconcilers.size === 0) return;
  const touched = new Map<string, Set<string>>();
  const touch = (model: string): Set<string> => {
    const keys = touched.get(model) ?? new Set<string>();
    touched.set(model, keys);
    return keys;
  };
  // Two shapes of the same loss: membership left a scope, or the row itself is gone. A destroyed row
  // of a model that declares no scope reaches the reader only through the row change.
  for (const change of batch.scopes) touch(change.model).add(change.scopeKey);
  for (const row of batch.rows) if (row.kind === 'destroy') touch(row.model);
  if (touched.size === 0) return;
  const client = getDbQueryClient();
  const maintenance = batch.mode === 'maintenance';
  for (const reconciler of reconcilers) {
    const keys = touched.get(reconciler.modelId);
    if (!keys) continue;
    for (const chain of reconciler.chains()) {
      // A model-destination chain depends on row presence alone, so any touch of its model applies.
      if (chain.scopeKey !== null && !keys.has(chain.scopeKey)) continue;
      const state = client.getQueryState(chain.queryKey);
      // A chain writing its own result is mid-flight: judge it once that write lands.
      if (state === undefined || state.fetchStatus === 'fetching') continue;
      const meta = state.data as { ids?: string[] } | undefined;
      if (!meta?.ids || meta.ids.length === 0) continue;
      const materialized = chain.materialized();
      const remaining = meta.ids.filter(id => materialized.has(id));
      if (remaining.length === meta.ids.length) continue;
      // Keep the original freshness stamp: shrinking the survivor set must never make a query fresher.
      client.setQueryData(chain.queryKey, { ...meta, ids: remaining }, { updatedAt: state.dataUpdatedAt });
      if (remaining.length > 0) continue;
      void client.invalidateQueries({ queryKey: chain.queryKey, exact: true, refetchType: 'none' });
      if (!maintenance) refetchActiveFetchReaders(chain.queryKey);
    }
  }
};

getCommitBus().subscribeAll(noteLostMaterialization);

/** Register one query so committed materialization loss can prune its chain; returns the release callback. */
export const registerMaterializationReconciler = (reconciler: MaterializationReconciler): (() => void) => {
  reconcilers.add(reconciler);
  return () => reconcilers.delete(reconciler);
};

/** Register one live query/fetch reader for loss-driven refetch and foreground resume; returns the release callback. */
export const registerActiveFetchReaders = (reader: ActiveFetchReader): (() => void) => {
  readers.add(reader);
  return () => readers.delete(reader);
};

/** Refetch every active reader of one query key: invalidation stays lazy for keys nobody is reading. */
export const refetchActiveFetchReaders = (queryKey: QueryKey): void => {
  const target = serializedKeyOf(queryKey);
  for (const reader of readers) {
    if (serializedKeyOf(reader.queryKey) === target) void reader.refetch().catch(() => {});
  }
};

/** Resume every active reader whose freshness lapsed, in provider-owned chunks. */
export const resumeFetchReaders = async (chunkSize: number, isCurrent: () => boolean): Promise<number> => {
  const refetches = [...readers].filter(reader => reader.markResumeStale());
  let refetched = 0;
  for (let index = 0; index < refetches.length; index += chunkSize) {
    if (!isCurrent()) return refetched;
    const chunk = refetches.slice(index, index + chunkSize);
    refetched += chunk.length;
    await Promise.all(chunk.map(reader => Promise.resolve().then(reader.refetch).catch(() => {})));
  }
  return refetched;
};
