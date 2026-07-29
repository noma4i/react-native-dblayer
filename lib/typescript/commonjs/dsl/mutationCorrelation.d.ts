import type { MutationCorrelate, OperationRecord } from '../types';
export declare const registerMutationCorrelator: (modelId: string, mutationId: string, correlate: MutationCorrelate) => void;
/** Fast hot-path gate: models without a declared correlator skip normalization and candidate scans entirely. */
export declare const modelHasCorrelators: (modelId: string) => boolean;
/**
 * Resolve the still-open temp row an incoming server row logically IS, per the model's declared
 * correlators. Candidates come from the durable ledger (open insert operations), never from a
 * whole-model scan; ties resolve to the oldest operation (FIFO - servers confirm sends in order).
 * Returns null for temp ids, rows already present, models without correlators, or no match.
 */
export declare const correlateIncomingRow: (modelId: string, incoming: Record<string, unknown> & {
    id: string;
}, options: {
    readRow: (id: string) => Record<string, unknown> | undefined;
    claimedTempIds: ReadonlySet<string>;
}) => {
    tempId: string;
    operation: OperationRecord;
} | null;
//# sourceMappingURL=mutationCorrelation.d.ts.map