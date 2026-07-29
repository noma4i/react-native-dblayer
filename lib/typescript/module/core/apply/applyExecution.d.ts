import type { IncrementalCommitBatch, JournalOp } from '../../types';
export declare const touchedModelsOf: (ops: JournalOp[]) => string[];
export declare const applyAtomically: (ops: JournalOp[]) => IncrementalCommitBatch;
//# sourceMappingURL=applyExecution.d.ts.map