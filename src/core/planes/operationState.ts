export type OperationStatus = 'pending' | 'committed' | 'rolledback';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = { operationId: string; model: string; tempIds: string[]; intent: OperationIntent; status: OperationStatus; idempotencyKey?: string; createdAt: number };

export type OperationState = {
  begin(operation: Omit<OperationRecord, 'status'>): void;
  close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
  pending(): OperationRecord[];
  reset(): void;
};

export const createOperationState = (): OperationState => {
  const operations = new Map<string, OperationRecord>();
  return {
    begin: operation => operations.set(operation.operationId, { ...operation, status: 'pending' }),
    close: (operationId, status) => {
      const operation = operations.get(operationId);
      if (!operation) return;
      operations.delete(operationId);
    },
    pending: () => [...operations.values()].filter(operation => operation.status === 'pending'),
    reset: () => operations.clear()
  };
};
