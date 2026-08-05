"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.resumeFetchReaders = exports.registerMaterializationReconciler = exports.registerActiveFetchReaders = exports.refetchActiveFetchReaders = void 0;
var _configure = require("../../dsl/configure.js");
var _diagnostics = require("../diagnostics.js");
var _reset = require("../reset.js");
var _serialize = require("../serialize.js");
const readers = new Set();
(0, _reset.registerReset)(() => readers.clear());
const serializedKeyOf = queryKey => (0, _serialize.stableSerialize)(queryKey);

/**
 * Committed materialization feed. Freshness is only valid while the applied result is still
 * materialized, and a chain loses an id for one reason with two shapes: the row was destroyed, or
 * the row survived but left the destination scope (complete-coverage snapshot, retention trim). Both
 * reach the reader as a touched scope - `applyExecution` records the
 * reactive scopes of destroyed rows alongside scope writes - so one feed covers the invariant.
 * Each registered query prunes what it no longer materializes and goes stale once nothing is left.
 */
const reconcilers = new Set();
(0, _reset.registerReset)(() => reconcilers.clear());

/** Chains that skipped a loss judgment mid-fetch, keyed by serialized query key: judged again once that fetch settles. */

const pendingRejudges = new Map();
let releasePendingWatch;
const stopPendingWatch = () => {
  releasePendingWatch?.();
  releasePendingWatch = undefined;
};
(0, _reset.registerReset)(() => {
  pendingRejudges.clear();
  stopPendingWatch();
});
const rejudgePending = (pending, target) => {
  if (!(0, _configure.isDbConfigured)() || !reconcilers.has(pending.reconciler)) return;
  const client = (0, _configure.getDbQueryClient)();
  for (const chain of pending.reconciler.chains()) {
    if (serializedKeyOf(chain.queryKey) !== target) continue;
    judgeChain(client, pending.reconciler, chain, pending.swap, pending.maintenance);
  }
};
const watchPendingSettles = () => {
  if (releasePendingWatch !== undefined) return;
  releasePendingWatch = (0, _configure.getDbQueryClient)().getQueryCache().subscribe(event => {
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
const rememberPendingRejudge = (reconciler, chain, swap, maintenance) => {
  const target = serializedKeyOf(chain.queryKey);
  const pending = pendingRejudges.get(target);
  if (pending === undefined) {
    pendingRejudges.set(target, {
      reconciler,
      swap: swap && new Map(swap),
      maintenance
    });
  } else {
    if (swap !== undefined) {
      pending.swap ??= new Map();
      for (const [from, to] of swap) pending.swap.set(from, to);
    }
    pending.maintenance = pending.maintenance && maintenance;
  }
  watchPendingSettles();
};
const judgeChain = (client, reconciler, chain, swap, maintenance) => {
  const state = client.getQueryState(chain.queryKey);
  if (state === undefined) return;
  // A chain writing its own result is mid-flight: judge it again once that fetch settles.
  if (state.fetchStatus === 'fetching') {
    rememberPendingRejudge(reconciler, chain, swap, maintenance);
    return;
  }
  const meta = state.data;
  if (!meta?.ids || meta.ids.length === 0) return;
  // Rewrite swapped identities BEFORE the materialization check: the successor id is what
  // the chain now holds, so it is what must be judged for presence.
  const candidates = meta.ids.map(id => {
    const rowId = (0, _serialize.parseCompositeKey)(id)?.[1];
    const successor = rowId !== undefined ? swap?.get(rowId) : undefined;
    return successor !== undefined ? (0, _serialize.compositeKey)(reconciler.modelId, successor) : id;
  });
  const materialized = chain.materialized(candidates);
  const remaining = candidates.filter(id => materialized.has(id));
  if (remaining.length === meta.ids.length && remaining.every((id, index) => id === meta.ids[index])) return;
  // Keep the original freshness stamp: rewriting the survivor set must never make a query fresher.
  client.setQueryData(chain.queryKey, {
    ...meta,
    ids: remaining
  }, {
    updatedAt: state.dataUpdatedAt
  });
  // A full-length identity rewrite is not a loss; any shrink forfeits freshness.
  if (remaining.length === meta.ids.length) return;
  void client.invalidateQueries({
    queryKey: chain.queryKey,
    exact: true,
    refetchType: 'none'
  });
  if (remaining.length > 0) {
    (0, _diagnostics.noteChainSurvivorShrink)();
    return;
  }
  if (!maintenance) refetchActiveFetchReaders(chain.queryKey);
};
const noteLostMaterialization = batch => {
  if (!(0, _configure.isDbConfigured)() || reconcilers.size === 0) return;
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
  const client = (0, _configure.getDbQueryClient)();
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
(0, _configure.getCommitBus)().subscribeAll(noteLostMaterialization);

/** Register one query so committed materialization loss can prune its chain; returns the release callback. */
const registerMaterializationReconciler = reconciler => {
  reconcilers.add(reconciler);
  return () => reconcilers.delete(reconciler);
};

/** Register one live query/fetch reader for loss-driven refetch and foreground resume; returns the release callback. */
exports.registerMaterializationReconciler = registerMaterializationReconciler;
const registerActiveFetchReaders = reader => {
  readers.add(reader);
  return () => readers.delete(reader);
};

/** Refetch every active reader of one query key: invalidation stays lazy for keys nobody is reading. */
exports.registerActiveFetchReaders = registerActiveFetchReaders;
const refetchActiveFetchReaders = queryKey => {
  const target = serializedKeyOf(queryKey);
  for (const reader of readers) {
    if (serializedKeyOf(reader.queryKey) === target) void reader.refetch().catch(() => {});
  }
};

/** Resume every active reader whose freshness lapsed, in provider-owned chunks. */
exports.refetchActiveFetchReaders = refetchActiveFetchReaders;
const resumeFetchReaders = async (chunkSize, isCurrent) => {
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
exports.resumeFetchReaders = resumeFetchReaders;
//# sourceMappingURL=fetchReaderRegistry.js.map