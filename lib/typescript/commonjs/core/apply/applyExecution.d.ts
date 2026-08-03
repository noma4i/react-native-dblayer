import type { ApplyTarget, IncrementalCommitBatch, JournalOp } from '../../types';
export declare const touchedModelsOf: (ops: JournalOp[]) => string[];
export declare const applyAtomically: (ops: JournalOp[], commitEpoch: number, persist: (targets: readonly ApplyTarget[]) => void) => IncrementalCommitBatch;
//# sourceMappingURL=applyExecution.d.ts.map