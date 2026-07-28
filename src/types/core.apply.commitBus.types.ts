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
  subscribeIncremental(notify: () => void, deps: ReadonlyArray<Dependency>, onBatch: (batch: IncrementalCommitBatch | null) => void): CommitSubscription;
  subscribeAll(onBatch: (batch: IncrementalCommitBatch) => void): () => void;
  activeDependencies(): ReadonlyArray<Dependency>;
  publish(batch: IncrementalCommitBatch): void;
  publishAll(): void;
  subscriberCount(): number;
};

/** One commit-bus subscriber: its dependency set and notification callbacks. */
export type CommitSubscriber = { deps: ReadonlyArray<Dependency>; notify: () => void; onBatch?: (batch: IncrementalCommitBatch | null) => void };
