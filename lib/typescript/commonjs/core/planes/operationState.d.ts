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
export type OperationState = {
    begin(operation: Omit<OperationRecord, 'status'>): void;
    close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
    pending(): OperationRecord[];
    reset(): void;
};
export declare const createOperationState: () => OperationState;
//# sourceMappingURL=operationState.d.ts.map