import type { ApplyTarget, IncrementalCommitBatch, AppliedOp } from '../../types';
export declare const touchedModelsOf: (ops: AppliedOp[]) => string[];
export declare const applyAtomically: (ops: AppliedOp[], commitEpoch: number, persist: (targets: readonly ApplyTarget[]) => void) => IncrementalCommitBatch;
//# sourceMappingURL=applyExecution.d.ts.map