import type { ScopeIndexValue } from './core.planes.scopeIndex.types';
import type { StoredRow } from './core.relations.types';
import type { OperationTransition } from './core.planes.operationState.types';
import type { VersionedValue } from './core.persistenceCodec.types';

/** Raw model-owned intent accepted by the write-plan compiler. */
export type WriteOp =
  | { kind: 'upsert'; model: string; rows: unknown[]; origin?: 'event'; operationId?: string; mergeBase?: never; baseRevision?: number }
  /** Replace carries the prior row only through planning so write groups observe the same commit semantics. */
  | { kind: 'upsert'; model: string; rows: unknown[]; origin: 'replace'; mergeBase?: unknown; operationId?: string; baseRevision?: number }
  /** `operationId` lets a pending optimistic method-patch plan its own rollback while foreign patches keep its owned fields. */
  | { kind: 'patch'; model: string; id: string; patch: Record<string, unknown>; remove?: string[]; operationId?: string; baseRevision?: number }
  /** `replace` marks the destroy half of an identity swap during relation planning. */
  | { kind: 'destroy'; model: string; ids: string[]; tombstone?: boolean; origin?: 'replace'; operationTransitions?: OperationTransition[]; baseRevision?: number }
  | { kind: 'scope'; model: string; scopeKey: string; next: ScopeIndexValue }
  | { kind: 'scope-delta'; model: string; scopeKey: string; append: Array<{ id: string; orderKey?: string }>; detach: string[] }
  | { kind: 'counter'; model: string; id: string; field: string; delta: number };

/** Callback-free operation persisted in WAL and applied verbatim by commit and replay. */
export type JournalOp =
  | { kind: 'upsert'; model: string; rows: StoredRow[]; origin?: 'replace' }
  | { kind: 'destroy'; model: string; ids: string[]; tombstone?: boolean; origin?: 'replace' }
  | { kind: 'scope'; model: string; scopeKey: string; next: ScopeIndexValue }
  | { kind: 'scope-delta'; model: string; scopeKey: string; append: Array<{ id: string; orderKey: string }>; detach: string[] };

export type JournalRecord = {
  txId: string;
  runtimeEpoch: number;
  epoch: number;
  ops: JournalOp[];
  operationTransitions: OperationTransition[];
};

export type PersistedJournalRecord = Omit<JournalRecord, 'ops' | 'operationTransitions'> & {
  recordVersion: 2;
  ops: Array<VersionedValue<JournalOp>>;
  operationTransitions: Array<VersionedValue<OperationTransition>>;
};

export type Journal = {
  entry(record: JournalRecord): { key: string; value: string };
  coveredKeys(checkpointEpoch: number): string[];
  allRecords(): JournalRecord[];
  lastEpoch(): number;
};
