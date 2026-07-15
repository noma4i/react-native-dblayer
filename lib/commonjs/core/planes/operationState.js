"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createOperationState = void 0;
const CLOSED_TTL_MS = 60 * 60 * 1000;
const SEQUENCES_CAP = 512;
const createOperationState = options => {
  const {
    storage,
    prefix,
    now
  } = options;
  const operations = new Map();
  const sequences = new Map();
  const committedKeys = new Set();
  const pendingKeys = new Set();
  const hydratedPendingIds = new Set();
  const indexOperation = record => {
    if (!record.idempotencyKey) return;
    if (record.status === 'pending') pendingKeys.add(record.idempotencyKey);else pendingKeys.delete(record.idempotencyKey);
    if (record.status === 'committed') committedKeys.add(record.idempotencyKey);
  };
  const rebuildIndexes = () => {
    committedKeys.clear();
    pendingKeys.clear();
    for (const record of operations.values()) indexOperation(record);
  };
  const opsKey = () => `${prefix()}ops`;
  const seqKey = () => `${prefix()}seq`;
  return {
    begin: operation => {
      const record = {
        ...operation,
        status: 'pending'
      };
      operations.set(operation.operationId, record);
      indexOperation(record);
    },
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation) return;
      hydratedPendingIds.delete(operationId);
      const record = {
        ...operation,
        status
      };
      operations.set(operationId, record);
      indexOperation(record);
    },
    get: operationId => operations.get(operationId),
    hasCommitted: idempotencyKey => committedKeys.has(idempotencyKey),
    hasPending: idempotencyKey => pendingKeys.has(idempotencyKey),
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    hydratedPending: () => [...hydratedPendingIds].flatMap(operationId => {
      const operation = operations.get(operationId);
      return operation?.status === 'pending' ? [operation] : [];
    }),
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
      sequences.delete(key);
      sequences.set(key, next);
      if (sequences.size > SEQUENCES_CAP) {
        const oldest = sequences.keys().next().value;
        if (oldest !== undefined) sequences.delete(oldest);
      }
      return next;
    },
    persistEntries: () => [{
      key: opsKey(),
      value: operations.size > 0 ? JSON.stringify(Object.fromEntries(operations)) : null
    }, {
      key: seqKey(),
      value: sequences.size > 0 ? JSON.stringify(Object.fromEntries(sequences)) : null
    }],
    hydrate: () => {
      operations.clear();
      sequences.clear();
      hydratedPendingIds.clear();
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        try {
          for (const [operationId, record] of Object.entries(JSON.parse(rawOps))) {
            operations.set(operationId, record);
            if (record.status === 'pending') hydratedPendingIds.add(operationId);
          }
        } catch {
          storage.set([{
            key: opsKey(),
            value: null
          }]);
        }
      }
      const rawSeq = storage.get(seqKey());
      if (rawSeq) {
        try {
          for (const [key, value] of Object.entries(JSON.parse(rawSeq))) sequences.set(key, value);
        } catch {
          storage.set([{
            key: seqKey(),
            value: null
          }]);
        }
      }
      rebuildIndexes();
    },
    reset: () => {
      operations.clear();
      sequences.clear();
      committedKeys.clear();
      pendingKeys.clear();
      hydratedPendingIds.clear();
    }
  };
};
exports.createOperationState = createOperationState;
//# sourceMappingURL=operationState.js.map