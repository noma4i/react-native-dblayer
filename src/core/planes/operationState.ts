import type { StoragePlane } from './storagePlane';

export type OperationStatus = 'pending' | 'committed' | 'rolledback';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = {
  operationId: string;
  model: string;
  tempIds: string[];
  intent: OperationIntent;
  status: OperationStatus;
  idempotencyKey?: string;
  createdAt: number;
};

const CLOSED_TTL_MS = 60 * 60 * 1000;

export type OperationState = {
  begin(operation: Omit<OperationRecord, 'status'>): void;
  close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
  get(operationId: string): OperationRecord | undefined;
  /** True when an idempotency key already committed - callers must skip re-applying. */
  hasCommitted(idempotencyKey: string): boolean;
  /** True while an idempotency key has a pending operation - blocks double-taps. */
  hasPending(idempotencyKey: string): boolean;
  pending(): OperationRecord[];
  prune(): number;
  /** Monotonic keyed sequence (e.g. an optimistic ordering floor per parent row); floor raises the base. */
  nextSequence(key: string, floor: number): number;
  persistEntries(): Array<{ key: string; value: string | null }>;
  hydrate(): void;
  reset(): void;
};

export const createOperationState = (options: { storage: StoragePlane; prefix: () => string; now: () => number }): OperationState => {
  const { storage, prefix, now } = options;
  const operations = new Map<string, OperationRecord>();
  const sequences = new Map<string, number>();
  const committedKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const indexOperation = (record: OperationRecord): void => {
    if (!record.idempotencyKey) return;
    if (record.status === 'pending') pendingKeys.add(record.idempotencyKey);
    else pendingKeys.delete(record.idempotencyKey);
    if (record.status === 'committed') committedKeys.add(record.idempotencyKey);
  };
  const rebuildIndexes = (): void => {
    committedKeys.clear();
    pendingKeys.clear();
    for (const record of operations.values()) indexOperation(record);
  };
  const opsKey = () => `${prefix()}ops`;
  const seqKey = () => `${prefix()}seq`;

  return {
    begin: operation => {
      const record: OperationRecord = { ...operation, status: 'pending' };
      operations.set(operation.operationId, record);
      indexOperation(record);
    },
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation) return;
      const record: OperationRecord = { ...operation, status };
      operations.set(operationId, record);
      indexOperation(record);
    },
    get: operationId => operations.get(operationId),
    hasCommitted: idempotencyKey => committedKeys.has(idempotencyKey),
    hasPending: idempotencyKey => pendingKeys.has(idempotencyKey),
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    prune: () => {
      const cutoff = now() - CLOSED_TTL_MS;
      let pruned = 0;
      for (const [operationId, operation] of operations) {
        if (operation.status !== 'pending' && operation.createdAt < cutoff) {
          operations.delete(operationId);
          pruned += 1;
        }
      }
      if (pruned > 0) rebuildIndexes();
      return pruned;
    },
    nextSequence: (key, floor) => {
      const next = Math.max(sequences.get(key) ?? 0, floor) + 1;
      sequences.set(key, next);
      return next;
    },
    persistEntries: () => [
      { key: opsKey(), value: JSON.stringify(Object.fromEntries(operations)) },
      { key: seqKey(), value: JSON.stringify(Object.fromEntries(sequences)) }
    ],
    hydrate: () => {
      operations.clear();
      sequences.clear();
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        try {
          for (const [operationId, record] of Object.entries(JSON.parse(rawOps) as Record<string, OperationRecord>)) operations.set(operationId, record);
        } catch {
          storage.set([{ key: opsKey(), value: null }]);
        }
      }
      const rawSeq = storage.get(seqKey());
      if (rawSeq) {
        try {
          for (const [key, value] of Object.entries(JSON.parse(rawSeq) as Record<string, number>)) sequences.set(key, value);
        } catch {
          storage.set([{ key: seqKey(), value: null }]);
        }
      }
      rebuildIndexes();
    },
    reset: () => {
      operations.clear();
      sequences.clear();
      committedKeys.clear();
      pendingKeys.clear();
    }
  };
};
