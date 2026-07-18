export type RowChange = { model: string; id: string; fields: string[] | null };
export type ScopeChange = { model: string; scopeKey: string };
export type CommitBatch = { rows: RowChange[]; scopes: ScopeChange[] };
export type IncrementalBatchMode = 'delta' | 'bulk' | 'replace' | 'maintenance';
export type IncrementalScopeChange = {
  model: string;
  scopeKey: string;
  ids?: string[];
  appendIds?: string[];
  /** Sparse orders of appended rows, carried from scope-delta ops for O(delta) mirroring. */
  appendEntries?: Array<{ id: string; order: number }>;
  detachIds?: string[];
  rebuild?: boolean;
};
export type IncrementalCommitBatch = CommitBatch & { mode?: IncrementalBatchMode; scopeChanges?: IncrementalScopeChange[]; maintenanceModels?: string[] };

export type Dependency =
  { kind: 'row'; model: string; id: string; fields?: ReadonlyArray<string> } | { kind: 'scope'; model: string; scopeKey: string } | { kind: 'model'; model: string };

export type CommitSubscription = { setDeps(deps: ReadonlyArray<Dependency>): void; unsubscribe(): void };

const rowMatches = (dep: { model: string; id: string; fields?: ReadonlyArray<string> }, change: RowChange): boolean => {
  if (dep.model !== change.model || dep.id !== change.id) return false;
  if (!dep.fields || change.fields === null) return true;
  return change.fields.some(field => dep.fields!.includes(field));
};

const depMatches = (dep: Dependency, batch: CommitBatch): boolean => {
  if (dep.kind === 'model') return batch.rows.some(change => change.model === dep.model) || batch.scopes.some(change => change.model === dep.model);
  if (dep.kind === 'scope') return batch.scopes.some(change => change.model === dep.model && change.scopeKey === dep.scopeKey);
  return batch.rows.some(change => rowMatches(dep, change));
};

/**
 * Semantic commit bus: one batched publish per applied plan; each subscriber declares a dependency
 * set (per-row, per-field, per-scope, or whole-model) and is notified at most once per batch,
 * only when the batch intersects its dependencies.
 */
export const createCommitBus = () => {
  const subscribers = new Set<{ deps: ReadonlyArray<Dependency>; notify: () => void; onBatch?: (batch: IncrementalCommitBatch | null) => void }>();
  const allSubscribers = new Set<(batch: IncrementalCommitBatch) => void>();
  const subscribe = (notify: () => void, deps: ReadonlyArray<Dependency> = [], onBatch?: (batch: IncrementalCommitBatch | null) => void): CommitSubscription => {
    const subscriber = { deps, notify, onBatch };
    subscribers.add(subscriber);
    return {
      setDeps: nextDeps => {
        subscriber.deps = nextDeps;
      },
      unsubscribe: () => subscribers.delete(subscriber)
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
      if (!batch.rows.length && !batch.scopes.length) return;
      for (const onBatch of [...allSubscribers]) onBatch(batch);
      for (const subscriber of [...subscribers]) {
        if (subscriber.deps.some(dep => depMatches(dep, batch))) {
          subscriber.onBatch?.(batch);
          subscriber.notify();
        }
      }
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

export type CommitBus = ReturnType<typeof createCommitBus>;
