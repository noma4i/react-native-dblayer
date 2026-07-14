"use strict";

export const createOperationState = () => {
  const operations = new Map();
  return {
    begin: operation => operations.set(operation.operationId, {
      ...operation,
      status: 'pending'
    }),
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation) return;
      operations.delete(operationId);
    },
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    reset: () => operations.clear()
  };
};
//# sourceMappingURL=operationState.js.map