"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createOperationState = void 0;
const CLOSED_TTL_MS = 60 * 60 * 1000;
const createOperationState = options => {
  const {
    storage,
    prefix,
    now
  } = options;
  const operations = new Map();
  const sequences = new Map();
  const opsKey = () => `${prefix()}ops`;
  const seqKey = () => `${prefix()}seq`;
  return {
    begin: operation => operations.set(operation.operationId, {
      ...operation,
      status: 'pending'
    }),
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation) return;
      operations.set(operationId, {
        ...operation,
        status
      });
    },
    get: operationId => operations.get(operationId),
    hasCommitted: idempotencyKey => [...operations.values()].some(operation => operation.idempotencyKey === idempotencyKey && operation.status === 'committed'),
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
      return pruned;
    },
    nextSequence: (key, floor) => {
      const next = Math.max(sequences.get(key) ?? 0, floor) + 1;
      sequences.set(key, next);
      return next;
    },
    persistEntries: () => [{
      key: opsKey(),
      value: JSON.stringify(Object.fromEntries(operations))
    }, {
      key: seqKey(),
      value: JSON.stringify(Object.fromEntries(sequences))
    }],
    hydrate: () => {
      operations.clear();
      sequences.clear();
      const rawOps = storage.get(opsKey());
      if (rawOps) {
        try {
          for (const [operationId, record] of Object.entries(JSON.parse(rawOps))) operations.set(operationId, record);
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
    },
    reset: () => {
      operations.clear();
      sequences.clear();
    }
  };
};
exports.createOperationState = createOperationState;
//# sourceMappingURL=operationState.js.map