import type { DataLossMechanism } from '../types';
export declare const noteCommit: () => void;
export declare const noteCommitFanout: (candidates: number, notified: number) => void;
export declare const noteFkIndex: (kind: "full" | "incremental", rows: number) => void;
export declare const noteReadEngineApply: (kind: "delta" | "rebuild", rows: number) => void;
/** Record one model-read scan by its row count, without per-row instrumentation. */
export declare const noteReadEngineScan: (rows: number) => void;
export declare const noteScopeReadPass: (resorted: boolean) => void;
export declare const noteResumeDrain: (refetched: number) => void;
export declare const noteEntityUpsertGuardHit: () => void;
/** Count membership feed messages actually written - the work-counter behind same-pairs replaceAll staying at zero. */
export declare const noteMembershipWrites: (count: number) => void;
export declare const noteCorruptionJournalDrop: () => void;
export declare const noteCorruptionJournalLoss: () => void;
export declare const noteCorruptionLedgerReset: () => void;
/** Count persisted scope keys rewritten from the colon-delimited format. */
export declare const noteManifestReset: () => void;
export declare const noteReplaceRejected: () => void;
/** A plan failed both its initial atomic apply and clean retry; its WAL stays pending and reads remain poisoned. */
export declare const noteApplyFailure: () => void;
/** An ingest declaration threw before or during apply: the event is reported through `onSyncError`, not silently dropped. */
export declare const noteIngestFailure: () => void;
/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
export declare const noteDataLoss: (mechanism: DataLossMechanism, model: string, count: number) => void;
//# sourceMappingURL=diagnostics.d.ts.map