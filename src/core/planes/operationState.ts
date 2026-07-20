import type { StoragePlane } from './storagePlane';

export type OperationStatus = 'pending' | 'committed' | 'rolledback' | 'failed';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = {
  operationId: string;
  model: string;
  tempIds: string[];
  rowIds?: string[];
  intent: OperationIntent;
  status: OperationStatus;
  idempotencyKey?: string;
  /** Retain a committed idempotency key until reset. Default operations guard only while pending. */
  once?: boolean;
  /** Top-level fields an optimistic method-patch owns while pending; incoming non-optimistic writes keep the current (optimistic) value for these until the op closes. */
  patchedFields?: string[];
  /** The concrete field->value map an optimistic method-patch wrote; used to resolve a field to the latest still-pending patch on rollback. */
  patchedValues?: Record<string, unknown>;
  createdAt: number;
};

const CLOSED_TTL_MS = 60 * 60 * 1000;
const SEQUENCES_CAP = 512;

export type OperationState = {
  begin(operation: Omit<OperationRecord, 'status'>): void;
  close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
  get(operationId: string): OperationRecord | undefined;
  /** True when a retained `once` key or exact operation id already committed. */
  hasCommitted(idempotencyKey: string): boolean;
  /** True while an idempotency key has a pending operation - blocks double-taps. */
  hasPending(idempotencyKey: string): boolean;
  pending(): OperationRecord[];
  /** Most recent retained failed operation for one model row. */
  failedFor(model: string, rowId: string): OperationRecord | undefined;
  /** Remove one retained failed operation after retry, discard, or reconciliation. */
  clearFailed(operationId: string): void;
  /** Pending records loaded by hydrate; only these are crash orphans during boot reconciliation. */
  hydratedPending(): OperationRecord[];
  prune(): number;
  /** Monotonic keyed sequence (e.g. an optimistic ordering floor per parent row); floor raises the base. */
  nextSequence(key: string, floor: number): number;
  /** Union of fields owned by still-pending optimistic patch ops on one model row (empty when none). */
  ownedFields(model: string, rowId: string, excludeOpId?: string): ReadonlySet<string>;
  /** The value the latest still-pending patch op (excluding `excludeOpId`) wrote for one field of one model row, or `{ found: false }` when no other pending patch owns it. */
  latestPendingValue(model: string, rowId: string, field: string, excludeOpId?: string): { found: boolean; value: unknown };
  persistEntries(): Array<{ key: string; value: string | null }>;
  hydrate(): void;
  reset(): void;
};

export const createOperationState = (options: { storage: StoragePlane; prefix: () => string; now: () => number; notify?: (record: OperationRecord) => void }): OperationState => {
  const { storage, prefix, now, notify } = options;
  const operations = new Map<string, OperationRecord>();
  const sequences = new Map<string, number>();
  const committedKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const hydratedPendingIds = new Set<string>();
  let sequencesDirty = false;
  let pendingPatchCount = 0;
  const indexOperation = (record: OperationRecord): void => {
    if (!record.idempotencyKey) return;
    if (record.status === 'pending') pendingKeys.add(record.idempotencyKey);
    else pendingKeys.delete(record.idempotencyKey);
    if (record.status === 'committed' && record.once === true) committedKeys.add(record.idempotencyKey);
  };
  const rebuildIndexes = (): void => {
    committedKeys.clear();
    pendingKeys.clear();
    for (const record of operations.values()) indexOperation(record);
  };
  const opsKey = () => `${prefix()}ops`;
  const seqKey = () => `${prefix()}seq`;
  const persistEntries = (): Array<{ key: string; value: string | null }> => {
    const entries = [{ key: opsKey(), value: operations.size > 0 ? JSON.stringify(Object.fromEntries(operations)) : null }];
    if (sequencesDirty) {
      entries.push({ key: seqKey(), value: sequences.size > 0 ? JSON.stringify(Object.fromEntries(sequences)) : null });
      sequencesDirty = false;
    }
    return entries;
  };
  const EMPTY_OWNED: ReadonlySet<string> = new Set();

  return {
    begin: operation => {
      const record: OperationRecord = { ...operation, status: 'pending' };
      operations.set(operation.operationId, record);
      indexOperation(record);
      if (record.status === 'pending' && record.intent === 'patch' && record.patchedFields && record.patchedFields.length > 0) pendingPatchCount += 1;
      storage.set(persistEntries());
      notify?.(record);
    },
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation) return;
      const wasPatchOwner = operation.status === 'pending' && operation.intent === 'patch' && !!operation.patchedFields && operation.patchedFields.length > 0;
      hydratedPendingIds.delete(operationId);
      if (operation.idempotencyKey) pendingKeys.delete(operation.idempotencyKey);
      const retainKey = status === 'committed' && operation.once === true;
      const record: OperationRecord = { ...operation, status, idempotencyKey: retainKey ? operation.idempotencyKey : undefined };
      operations.set(operationId, record);
      if (wasPatchOwner) pendingPatchCount -= 1;
      indexOperation(record);
      storage.set(persistEntries());
      notify?.(record);
    },
    get: operationId => operations.get(operationId),
    hasCommitted: idempotencyKey => committedKeys.has(idempotencyKey) || operations.get(idempotencyKey)?.status === 'committed',
    hasPending: idempotencyKey => pendingKeys.has(idempotencyKey),
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    failedFor: (model, rowId) => {
      let latest: OperationRecord | undefined;
      for (const operation of operations.values()) {
        if (operation.status !== 'failed' || operation.model !== model || ![...operation.tempIds, ...(operation.rowIds ?? [])].includes(rowId)) continue;
        if (!latest || operation.createdAt >= latest.createdAt) latest = operation;
      }
      return latest;
    },
    clearFailed: operationId => {
      const operation = operations.get(operationId);
      if (!operation || operation.status !== 'failed') return;
      operations.delete(operationId);
      rebuildIndexes();
      storage.set(persistEntries());
      notify?.(operation);
    },
    hydratedPending: () =>
      [...hydratedPendingIds].flatMap(operationId => {
        const operation = operations.get(operationId);
        return operation?.status === 'pending' ? [operation] : [];
      }),
    prune: () => {
      const cutoff = now() - CLOSED_TTL_MS;
      let pruned = 0;
      for (const [operationId, operation] of operations) {
        const retainedOnce = operation.status === 'committed' && operation.once === true;
        if (operation.status !== 'pending' && operation.status !== 'failed' && !retainedOnce && operation.createdAt < cutoff) {
          operations.delete(operationId);
          pruned += 1;
        }
      }
      if (pruned > 0) rebuildIndexes();
      return pruned;
    },
    nextSequence: (key, floor) => {
      const next = Math.max(sequences.get(key) ?? 0, floor) + 1;
      sequences.delete(key);
      sequences.set(key, next);
      if (sequences.size > SEQUENCES_CAP) {
        const oldest = sequences.keys().next().value;
        if (oldest !== undefined) sequences.delete(oldest);
      }
      sequencesDirty = true;
      return next;
    },
    ownedFields: (model, rowId, excludeOpId) => {
      if (pendingPatchCount === 0) return EMPTY_OWNED;
      let owned: Set<string> | undefined;
      for (const operation of operations.values()) {
        if (operation.status !== 'pending' || operation.intent !== 'patch' || !operation.patchedFields || operation.patchedFields.length === 0) continue;
        if (operation.operationId === excludeOpId) continue;
        if (operation.model !== model || !(operation.rowIds ?? []).includes(rowId)) continue;
        owned ??= new Set<string>();
        for (const field of operation.patchedFields) owned.add(field);
      }
      return owned ?? EMPTY_OWNED;
    },
    latestPendingValue: (model, rowId, field, excludeOpId) => {
      if (pendingPatchCount === 0) return { found: false, value: undefined };
      let result: { found: boolean; value: unknown } = { found: false, value: undefined };
      for (const operation of operations.values()) {
        if (operation.status !== 'pending' || operation.intent !== 'patch' || operation.operationId === excludeOpId) continue;
        if (operation.model !== model || !(operation.rowIds ?? []).includes(rowId)) continue;
        if (operation.patchedValues && field in operation.patchedValues) result = { found: true, value: operation.patchedValues[field] };
      }
      return result;
    },
    persistEntries,
    hydrate: () => {
      operations.clear();
      sequences.clear();
      hydratedPendingIds.clear();
      sequencesDirty = false;
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        try {
          for (const [operationId, record] of Object.entries(JSON.parse(rawOps) as Record<string, OperationRecord>)) {
            const retainKey = record.status === 'pending' || (record.status === 'committed' && record.once === true);
            const hydratedRecord = retainKey ? record : { ...record, idempotencyKey: undefined };
            operations.set(operationId, hydratedRecord);
            if (hydratedRecord.status === 'pending') hydratedPendingIds.add(operationId);
          }
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
      pendingPatchCount = 0;
      for (const op of operations.values()) if (op.status === 'pending' && op.intent === 'patch' && op.patchedFields && op.patchedFields.length > 0) pendingPatchCount += 1;
    },
    reset: () => {
      operations.clear();
      sequences.clear();
      committedKeys.clear();
      pendingKeys.clear();
      hydratedPendingIds.clear();
      sequencesDirty = false;
      pendingPatchCount = 0;
    }
  };
};
