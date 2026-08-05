"use strict";

export class SyncFeed {
  methods = null;
  sync = methods => {
    this.methods = methods;
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };
  start() {
    this.requireMethods().begin();
  }
  pushMessage(message) {
    this.requireMethods().write(message);
  }
  finish() {
    this.requireMethods().commit();
  }
  truncate() {
    this.requireMethods().truncate();
  }
  markReady() {
    this.requireMethods().markReady();
  }
  requireMethods() {
    if (!this.methods) throw new Error('Store sync feed is not connected');
    return this.methods;
  }
}

/**
 * Lifetime of every collection this package creates. The store that created a collection is the
 * only thing that ends its life: rows leave memory when the store evicts them - destroy, reset, or
 * dispose - and at no other moment.
 *
 * The collection library otherwise runs its own retention timer and clears a collection that spent
 * `gcTime` with no subscriber. Two things break when that fires behind the store: the rows are gone
 * while the app still holds them, and every index built over the collection keeps its keys, so a
 * lookup then names rows the collection no longer holds.
 */
export const OWNED_COLLECTION_LIFETIME = {
  gcTime: Infinity
};
let applyBatchDepth = 0;
let applyBatchFailed = false;
let storeReadsPoisoned = false;
const pendingBatchFlushes = new Set();
let storeTransactionDepth = 0;
let storeTransactionCompletions = [];

/**
 * Group every collection feed touched by one store transition. Nested callers join the same
 * package-owned boundary, and completion callbacks run only after every feed reached final state.
 */
export const runInStoreTransaction = run => {
  if (storeTransactionDepth > 0) return run();
  storeTransactionDepth = 1;
  try {
    return run();
  } finally {
    // Completions drain on failure too: collection feeds already committed their writes, and a
    // dropped completion would leave the batcher latch armed, silently eating every later delta.
    storeTransactionDepth = 0;
    const completions = storeTransactionCompletions;
    storeTransactionCompletions = [];
    for (const complete of completions) complete();
  }
};
export const isInStoreTransaction = () => storeTransactionDepth > 0;
export const afterStoreTransaction = complete => {
  if (storeTransactionDepth > 0) {
    storeTransactionCompletions.push(complete);
    return;
  }
  complete();
};

/** Coalesce engine changes until every collection in the outer store transaction is final. */
export const createStoreTransactionBatcher = deliver => {
  let active = true;
  let scheduled = false;
  let pending = [];
  return {
    push: items => {
      if (!active || items.length === 0) return;
      if (!isInStoreTransaction()) {
        deliver([...items]);
        return;
      }
      pending.push(...items);
      if (scheduled) return;
      scheduled = true;
      afterStoreTransaction(() => {
        scheduled = false;
        const batch = pending;
        pending = [];
        if (active && batch.length > 0) deliver(batch);
      });
    },
    dispose: () => {
      active = false;
      pending = [];
    }
  };
};

/**
 * Run one apply pass with batched collection flushes: every store write inside `run` lands in a
 * per-store transactional buffer (readable through the store immediately) and is committed to the
 * collections as one sync-feed transaction per store when the pass ends, so live queries observe
 * one consistent tick instead of per-row churn. A failure aborts every participating store buffer.
 */
export const runInApplyBatch = run => {
  applyBatchDepth += 1;
  try {
    return run();
  } catch (error) {
    applyBatchFailed = true;
    throw error;
  } finally {
    applyBatchDepth -= 1;
    if (applyBatchDepth === 0) {
      const flushes = [...pendingBatchFlushes];
      pendingBatchFlushes.clear();
      const failed = applyBatchFailed;
      applyBatchFailed = false;
      for (const entry of flushes) {
        if (failed) entry.abort();else entry.flush();
      }
    }
  }
};
export const isInApplyBatch = () => applyBatchDepth > 0;
export const enqueueBatchParticipant = participant => {
  pendingBatchFlushes.add(participant);
};
export const removeBatchParticipant = participant => {
  pendingBatchFlushes.delete(participant);
};
export const poisonStoreReads = () => {
  storeReadsPoisoned = true;
};
export const restoreStoreReads = () => {
  storeReadsPoisoned = false;
};
export const assertStoreReadable = () => {
  if (storeReadsPoisoned) throw new Error('Database apply state is poisoned');
};
//# sourceMappingURL=storeSync.js.map