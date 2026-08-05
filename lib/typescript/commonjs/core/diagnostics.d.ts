import type { DataLossMechanism } from '../types';
export declare const noteCommit: () => void;
export declare const noteCommitFanout: (candidates: number, notified: number) => void;
/** One incremental update of a declared query, sized by the rows it moved. */
export declare const noteReadEngineApply: (rows: number) => void;
/** Record one model-read scan by its row count, without per-row instrumentation. */
export declare const noteReadEngineScan: (rows: number) => void;
export declare const noteScopeReadPass: (resorted: boolean) => void;
export declare const noteResumeDrain: (refetched: number) => void;
export declare const noteEntityUpsertGuardHit: () => void;
/** Count membership feed messages actually written - the work-counter behind same-pairs replaceAll staying at zero. */
export declare const noteRelationChildScan: () => void;
export declare const noteMembershipWrites: (count: number) => void;
export declare const noteCorruptionLedgerReset: () => void;
/** Count cold resets caused by an incompatible persistence manifest. */
export declare const noteManifestReset: () => void;
export declare const noteReplaceRejected: () => void;
/** A plan failed both its initial atomic apply and clean retry; reads remain poisoned. */
export declare const noteApplyFailure: () => void;
/** Count payloads kept in the quarantine instead of being dropped. */
export declare const noteQuarantinePut: () => void;
/** Count landings gated out by a live tombstone - the discriminator for vanished-window defects. */
export declare const noteTombstoneWriteDrop: () => void;
/** Count query chains shrunk by materialization loss while survivors remain. */
export declare const noteChainSurvivorShrink: () => void;
/** Count scope members whose entity row is absent at read time - must stay 0 after boot fsck. */
export declare const noteMembershipMissingEntity: (count: number) => void;
/** Count counter ops skipped for a non-resident parent or non-numeric base. */
export declare const noteCounterOpDrop: () => void;
/** Count touch effects dropped because the parent row is not resident in the plan. */
export declare const noteNonResidentTouchDrop: () => void;
/** Count terminal ledger acks aimed at an unknown or already-closed operation. */
export declare const noteUnknownOperationAck: () => void;
/** Count rows or fields evicted by causal admission (stale baseRevision against newer committed state). */
export declare const noteCausalAdmissionDrop: () => void;
/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
export declare const noteDataLoss: (mechanism: DataLossMechanism, model: string, count: number) => void;
//# sourceMappingURL=diagnostics.d.ts.map