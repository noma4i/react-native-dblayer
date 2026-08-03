import type { OperationRecord, OperationState, OperationTransition, StoragePlane } from '../../types';
export declare const isOperationRecord: (value: unknown) => value is OperationRecord;
export declare const isOperationTransition: (value: unknown) => value is OperationTransition;
/** Corrupt sources are counted, not reported here: the manifest cold-reset caller runs `resetRuntime`
 * (which clears diagnostics) right after this read, so it reports the loss itself once reset is done. */
export declare const readCommittedOnceKeys: (storage: StoragePlane, prefix: string) => {
    keys: string[];
    corruptSources: number;
};
export declare const writeCommittedOnceKeys: (storage: StoragePlane, prefix: string, keys: readonly string[]) => void;
export declare const committedOnceKeysEntry: (prefix: string, keys: readonly string[]) => {
    key: string;
    value: string;
} | undefined;
/** JSON-round-trip an operation input before it enters the persistent ledger. */
export declare const serializeOperationInput: (input: unknown) => {
    serializable: boolean;
    value: unknown;
};
export declare const createOperationState: (options: {
    storage: StoragePlane;
    prefix: () => string;
    now: () => number;
}) => OperationState;
//# sourceMappingURL=operationState.d.ts.map