import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { IncrementalCommitBatch , ActiveFetchReader, MaterializationReconciler, MaterializedChain } from '../../types';
import { getCommitBus, getDbQueryClient, isDbConfigured } from '../../dsl/configure';
import { noteChainSurvivorShrink } from '../diagnostics';
import { registerReset } from '../reset';
import { compositeKey, parseCompositeKey, stableSerialize } from '../serialize';

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

/** Chains that skipped a loss judgment mid-fetch, keyed by serialized query key: judged again once that fetch settles. */
type PendingRejudge = { reconciler: MaterializationReconciler; swap: Map<string, string> | undefined; maintenance: boolean };
const pendingRejudges = new Map<string, PendingRejudge>();
let releasePendingWatch: (() => void) | undefined;

const stopPendingWatch = (): void => {
  releasePendingWatch?.();
  releasePendingWatch = undefined;
};

registerReset(() => {
  pendingRejudges.clear();
  stopPendingWatch();
});

const rejudgePending = (pending: PendingRejudge, target: string): void => {
  if (!isDbConfigured() || !reconcilers.has(pending.reconciler)) return;
  const client = getDbQueryClient();
  for (const chain of pending.reconciler.chains()) {
    if (serializedKeyOf(chain.queryKey) !== target) continue;
    judgeChain(client, pending.reconciler, chain, pending.swap, pending.maintenance);
  }
};

const watchPendingSettles = (): void => {
  if (releasePendingWatch !== undefined) return;
  releasePendingWatch = getDbQueryClient().getQueryCache().subscribe(event => {
    if (event.type !== 'updated' && event.type !== 'removed') return;
    const target = serializedKeyOf(event.query.queryKey);
    const pending = pendingRejudges.get(target);
    if (pending === undefined) return;
    if (event.type === 'updated' && event.query.state.fetchStatus !== 'idle') return;
    pendingRejudges.delete(target);
    if (pendingRejudges.size === 0) stopPendingWatch();
    if (event.type === 'removed') return;
    // A successful landing re-establishes the chain itself; only a failed fetch leaves the
    // recorded loss unjudged (spec 08).
    if (event.query.state.status !== 'error') return;
    rejudgePending(pending, target);
  });
};

const rememberPendingRejudge = (reconciler: MaterializationReconciler, chain: MaterializedChain, swap: Map<string, string> | undefined, maintenance: boolean): void => {
  const target = serializedKeyOf(chain.queryKey);
  const pending = pendingRejudges.get(target);
  if (pending === undefined) {
    pendingRejudges.set(target, { reconciler, swap: swap && new Map(swap), maintenance });
  } else {
    if (swap !== undefined) {
      pending.swap ??= new Map<string, string>();
      for (const [from, to] of swap) pending.swap.set(from, to);
    }
    pending.maintenance = pending.maintenance && maintenance;
  }
  watchPendingSettles();
};

const judgeChain = (client: QueryClient, reconciler: MaterializationReconciler, chain: MaterializedChain, swap: Map<string, string> | undefined, maintenance: boolean): void => {
  const state = client.getQueryState(chain.queryKey);
  if (state === undefined) return;
  // A chain writing its own result is mid-flight: judge it again once that fetch settles.
  if (state.fetchStatus === 'fetching') {
    rememberPendingRejudge(reconciler, chain, swap, maintenance);
    return;
  }
  const meta = state.data as { ids?: string[] } | undefined;
  if (!meta?.ids || meta.ids.length === 0) return;
  // Rewrite swapped identities BEFORE the materialization check: the successor id is what
  // the chain now holds, so it is what must be judged for presence.
  const candidates = meta.ids.map(id => {
    const rowId = parseCompositeKey(id)?.[1];
    const successor = rowId !== undefined ? swap?.get(rowId) : undefined;
    return successor !== undefined ? compositeKey(reconciler.modelId, successor) : id;
  });
  const materialized = chain.materialized(candidates);
  const remaining = candidates.filter(id => materialized.has(id));
  if (remaining.length === meta.ids.length && remaining.every((id, index) => id === meta.ids![index])) return;
  // Keep the original freshness stamp: rewriting the survivor set must never make a query fresher.
  client.setQueryData(chain.queryKey, { ...meta, ids: remaining }, { updatedAt: state.dataUpdatedAt });
  // A full-length identity rewrite is not a loss; any shrink forfeits freshness.
  if (remaining.length === meta.ids.length) return;
  void client.invalidateQueries({ queryKey: chain.queryKey, exact: true, refetchType: 'none' });
  if (remaining.length > 0) {
    noteChainSurvivorShrink();
    return;
  }
  if (!maintenance) refetchActiveFetchReaders(chain.queryKey);
};

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
  // An identity SWAP is not a loss: the replace destroy leg names its successor, and the chain
  // follows the identity instead of pruning it.
  const successors = new Map<string, Map<string, string>>();
  for (const change of batch.scopes) touch(change.model).add(change.scopeKey);
  for (const row of batch.rows) {
    if (row.kind !== 'destroy') continue;
    touch(row.model);
    if (row.replacedBy === undefined) continue;
    const swap = successors.get(row.model) ?? new Map<string, string>();
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
      judgeChain(client, reconciler, chain, swap, maintenance);
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
