import type { CommitEnvelope, OperationTransition, WriteOp } from '../../types';
/**
 * Compile raw model intents into one complete callback-free plan before WAL.
 *
 * @param ops Raw model write intents.
 * @param explicitOperationTransitions Durable operation-ledger transitions composed with the plan.
 * @returns A complete commit envelope with entity work ordered before scope membership work.
 */
export declare const createCommitEnvelope: (ops: WriteOp[], explicitOperationTransitions?: readonly OperationTransition[]) => CommitEnvelope;
//# sourceMappingURL=commitEnvelope.d.ts.map