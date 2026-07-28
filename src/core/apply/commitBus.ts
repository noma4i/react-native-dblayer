import { noteCommitFanout } from '../diagnostics';

export type RowChange = { model: string; id: string; fields: string[] | null; kind?: 'upsert' | 'destroy' };
type ScopeChange = { model: string; scopeKey: string };
type PendingChange = { model: string; id: string };
export type CommitBatch = { rows: RowChange[]; scopes: ScopeChange[]; pending?: PendingChange[] };
type IncrementalBatchMode = 'delta' | 'bulk' | 'replace' | 'maintenance';
export type IncrementalScopeChange = {
  model: string;
  scopeKey: string;
  ids?: string[];
  appendIds?: string[];
  /** Sparse orders of appended rows, carried from scope-delta ops for O(delta) scope updates. */
  appendEntries?: Array<{ id: string; order: number }>;
  detachIds?: string[];
  rebuild?: boolean;
};
export type IncrementalCommitBatch = CommitBatch & { mode?: IncrementalBatchMode; scopeChanges?: IncrementalScopeChange[]; maintenanceModels?: string[] };

export type Dependency =
  | { kind: 'row'; model: string; id: string; fields?: ReadonlyArray<string> }
  | { kind: 'scope'; model: string; scopeKey: string }
  | { kind: 'model'; model: string }
  | { kind: 'pending'; model: string; id: string };

export type CommitSubscription = { setDeps(deps: ReadonlyArray<Dependency>): void; unsubscribe(): void };
export type CommitBus = {
  subscribe(notify: () => void, deps?: ReadonlyArray<Dependency>, onBatch?: (batch: IncrementalCommitBatch | null) => void): CommitSubscription;
  subscribeIncremental(
    notify: () => void,
    deps: ReadonlyArray<Dependency>,
    onBatch: (batch: IncrementalCommitBatch | null) => void
  ): CommitSubscription;
  subscribeAll(onBatch: (batch: IncrementalCommitBatch) => void): () => void;
  activeDependencies: () => ReadonlyArray<Dependency>;
  publish(batch: IncrementalCommitBatch): void;
  publishAll: () => void;
  subscriberCount: () => number;
};

type Subscriber = { deps: ReadonlyArray<Dependency>; notify: () => void; onBatch?: (batch: IncrementalCommitBatch | null) => void };

const rowMatches = (dep: { model: string; id: string; fields?: ReadonlyArray<string> }, change: RowChange): boolean => {
  if (dep.model !== change.model || dep.id !== change.id) return false;
  if (!dep.fields || change.fields === null) return true;
  return change.fields.some(field => dep.fields!.includes(field));
};

const depMatches = (dep: Dependency, batch: CommitBatch): boolean => {
  if (dep.kind === 'model') return batch.rows.some(change => change.model === dep.model) || batch.scopes.some(change => change.model === dep.model);
  if (dep.kind === 'scope') return batch.scopes.some(change => change.model === dep.model && change.scopeKey === dep.scopeKey);
  if (dep.kind === 'pending') return batch.pending?.some(change => change.model === dep.model && change.id === dep.id) === true;
  return batch.rows.some(change => rowMatches(dep, change));
};

/**
 * Semantic commit bus: one batched publish per applied plan; each subscriber declares a dependency
 * set (per-row, per-field, per-scope, per-pending-id, or whole-model) and is notified at most once per batch,
 * only when the batch intersects its dependencies.
 */
export const createCommitBus = (): CommitBus => {
  const subscribers = new Set<Subscriber>();
  const subscribersByModel = new Map<string, Set<Subscriber>>();
  const allSubscribers = new Set<(batch: IncrementalCommitBatch) => void>();
  const modelsOf = (deps: ReadonlyArray<Dependency>): Set<string> => new Set(deps.map(dep => dep.model));
  const addToModelBuckets = (subscriber: Subscriber, models: ReadonlySet<string>): void => {
    for (const model of models) {
      const bucket = subscribersByModel.get(model) ?? new Set<Subscriber>();
      bucket.add(subscriber);
      subscribersByModel.set(model, bucket);
    }
  };
  const removeFromModelBuckets = (subscriber: Subscriber, models: ReadonlySet<string>): void => {
    for (const model of models) {
      const bucket = subscribersByModel.get(model);
      if (!bucket) continue;
      bucket.delete(subscriber);
      if (bucket.size === 0) subscribersByModel.delete(model);
    }
  };
  const subscribe = (notify: () => void, deps: ReadonlyArray<Dependency> = [], onBatch?: (batch: IncrementalCommitBatch | null) => void): CommitSubscription => {
    const subscriber = { deps, notify, onBatch };
    subscribers.add(subscriber);
    addToModelBuckets(subscriber, modelsOf(deps));
    return {
      setDeps: nextDeps => {
        const previousModels = modelsOf(subscriber.deps);
        const nextModels = modelsOf(nextDeps);
        removeFromModelBuckets(subscriber, new Set([...previousModels].filter(model => !nextModels.has(model))));
        addToModelBuckets(subscriber, new Set([...nextModels].filter(model => !previousModels.has(model))));
        subscriber.deps = nextDeps;
      },
      unsubscribe: () => {
        removeFromModelBuckets(subscriber, modelsOf(subscriber.deps));
        subscribers.delete(subscriber);
      }
    };
  };

  return {
    subscribe,
    subscribeIncremental: (notify: () => void, deps: ReadonlyArray<Dependency>, onBatch: (batch: IncrementalCommitBatch | null) => void): CommitSubscription =>
      subscribe(notify, deps, onBatch),
    subscribeAll: (onBatch: (batch: IncrementalCommitBatch) => void): (() => void) => {
      allSubscribers.add(onBatch);
      return () => allSubscribers.delete(onBatch);
    },
    /** Snapshot of live reader dependencies, used as garbage-collection roots. */
    activeDependencies: (): ReadonlyArray<Dependency> => [...subscribers].flatMap(subscriber => subscriber.deps),
    publish: (batch: IncrementalCommitBatch): void => {
      if (!batch.rows.length && !batch.scopes.length && !batch.pending?.length) return;
      for (const onBatch of [...allSubscribers]) onBatch(batch);
      const batchModels = new Set([...batch.rows, ...batch.scopes, ...(batch.pending ?? [])].map(change => change.model));
      const candidates = new Set<Subscriber>();
      for (const model of batchModels) {
        for (const subscriber of subscribersByModel.get(model) ?? []) candidates.add(subscriber);
      }
      let notified = 0;
      for (const subscriber of [...candidates]) {
        if (subscriber.deps.some(dep => depMatches(dep, batch))) {
          subscriber.onBatch?.(batch);
          subscriber.notify();
          notified += 1;
        }
      }
      noteCommitFanout(candidates.size, notified);
    },
    publishAll: (): void => {
      for (const subscriber of [...subscribers]) {
        subscriber.onBatch?.(null);
        subscriber.notify();
      }
    },
    subscriberCount: () => subscribers.size
  };
};
