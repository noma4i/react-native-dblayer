"use strict";

import { getCommitBus, getDbQueryClient, isDbConfigured } from "../../dsl/configure.js";
import { registerReset } from "../reset.js";
import { compositeKey, parseCompositeKey, stableSerialize } from "../serialize.js";
const readers = new Set();
registerReset(() => readers.clear());
const serializedKeyOf = queryKey => stableSerialize(queryKey);

/**
 * Committed materialization feed. Freshness is only valid while the applied result is still
 * materialized, and a chain loses an id for one reason with two shapes: the row was destroyed, or
 * the row survived but left the destination scope (complete-coverage snapshot, retention trim). Both
 * reach the reader as a touched scope - `applyExecution` records the
 * reactive scopes of destroyed rows alongside scope writes - so one feed covers the invariant.
 * Each registered query prunes what it no longer materializes and goes stale once nothing is left.
 */
const reconcilers = new Set();
registerReset(() => reconcilers.clear());
const noteLostMaterialization = batch => {
  if (!isDbConfigured() || reconcilers.size === 0) return;
  const touched = new Map();
  const touch = model => {
    const keys = touched.get(model) ?? new Set();
    touched.set(model, keys);
    return keys;
  };
  // Two shapes of the same loss: membership left a scope, or the row itself is gone. A destroyed row
  // of a model that declares no scope reaches the reader only through the row change.
  // An identity SWAP is not a loss: the replace destroy leg names its successor, and the chain
  // follows the identity instead of pruning it.
  const successors = new Map();
  for (const change of batch.scopes) touch(change.model).add(change.scopeKey);
  for (const row of batch.rows) {
    if (row.kind !== 'destroy') continue;
    touch(row.model);
    if (row.replacedBy === undefined) continue;
    const swap = successors.get(row.model) ?? new Map();
    swap.set(row.id, row.replacedBy);
    successors.set(row.model, swap);
  }
  if (touched.size === 0) return;
  const client = getDbQueryClient();
  const maintenance = batch.mode === 'maintenance';
  for (const reconciler of reconcilers) {
    const keys = touched.get(reconciler.modelId);
    if (!keys) continue;
    const swap = successors.get(reconciler.modelId);
    for (const chain of reconciler.chains()) {
      // A model-destination chain depends on row presence alone, so any touch of its model applies.
      if (chain.scopeKey !== null && !keys.has(chain.scopeKey)) continue;
      const state = client.getQueryState(chain.queryKey);
      // A chain writing its own result is mid-flight: judge it once that write lands.
      if (state === undefined || state.fetchStatus === 'fetching') continue;
      const meta = state.data;
      if (!meta?.ids || meta.ids.length === 0) continue;
      // Rewrite swapped identities BEFORE the materialization check: the successor id is what
      // the chain now holds, so it is what must be judged for presence.
      const candidates = meta.ids.map(id => {
        const rowId = parseCompositeKey(id)?.[1];
        const successor = rowId !== undefined ? swap?.get(rowId) : undefined;
        return successor !== undefined ? compositeKey(reconciler.modelId, successor) : id;
      });
      const materialized = chain.materialized(candidates);
      const remaining = candidates.filter(id => materialized.has(id));
      if (remaining.length === meta.ids.length && remaining.every((id, index) => id === meta.ids[index])) continue;
      // Keep the original freshness stamp: rewriting or shrinking the survivor set must never
      // make a query fresher.
      client.setQueryData(chain.queryKey, {
        ...meta,
        ids: remaining
      }, {
        updatedAt: state.dataUpdatedAt
      });
      if (remaining.length > 0) continue;
      void client.invalidateQueries({
        queryKey: chain.queryKey,
        exact: true,
        refetchType: 'none'
      });
      if (!maintenance) refetchActiveFetchReaders(chain.queryKey);
    }
  }
};
getCommitBus().subscribeAll(noteLostMaterialization);

/** Register one query so committed materialization loss can prune its chain; returns the release callback. */
export const registerMaterializationReconciler = reconciler => {
  reconcilers.add(reconciler);
  return () => reconcilers.delete(reconciler);
};

/** Register one live query/fetch reader for loss-driven refetch and foreground resume; returns the release callback. */
export const registerActiveFetchReaders = reader => {
  readers.add(reader);
  return () => readers.delete(reader);
};

/** Refetch every active reader of one query key: invalidation stays lazy for keys nobody is reading. */
export const refetchActiveFetchReaders = queryKey => {
  const target = serializedKeyOf(queryKey);
  for (const reader of readers) {
    if (serializedKeyOf(reader.queryKey) === target) void reader.refetch().catch(() => {});
  }
};

/** Resume every active reader whose freshness lapsed, in provider-owned chunks. */
export const resumeFetchReaders = async (chunkSize, isCurrent) => {
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
//# sourceMappingURL=fetchReaderRegistry.js.map