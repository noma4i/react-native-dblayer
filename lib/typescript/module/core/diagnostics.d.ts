import type { DataLossMechanism, DataLossEvent } from '../types';
type DiagnosticsState = {
    commits: number;
    commitFanoutCandidates: number;
    commitFanoutNotified: number;
    fkIndexFullBuilds: number;
    fkIndexIncrementalUpdates: number;
    readEngineApplies: number;
    readEngineRebuilds: number;
    readEngineDeltaRows: number;
    readEngineScanRows: number;
    scopeReadPasses: number;
    scopeReadResorts: number;
    resumeDrains: number;
    resumeRefetches: number;
    entityUpsertGuardHits: number;
    corruptionJournalDrops: number;
    corruptionJournalLosses: number;
    corruptionLedgerResets: number;
    scopeKeyMigrations: number;
    manifestResets: number;
    replaceRejected: number;
    applyFailure: number;
    ingestFailed: number;
    dataLossEvents: DataLossEvent[];
};
export declare const noteCommit: () => void;
export declare const noteCommitFanout: (candidates: number, notified: number) => void;
export declare const noteFkIndex: (kind: "full" | "incremental", rows: number) => void;
export declare const noteReadEngineApply: (kind: "delta" | "rebuild", rows: number) => void;
/** Record one model-read scan by its row count, without per-row instrumentation. */
export declare const noteReadEngineScan: (rows: number) => void;
export declare const noteScopeReadPass: (resorted: boolean) => void;
export declare const noteResumeDrain: (refetched: number) => void;
export declare const noteEntityUpsertGuardHit: () => void;
export declare const noteCorruptionJournalDrop: () => void;
export declare const noteCorruptionJournalLoss: () => void;
export declare const noteCorruptionLedgerReset: () => void;
/** Count persisted scope keys rewritten from the colon-delimited format. */
export declare const noteScopeKeyMigration: (count: number) => void;
export declare const noteManifestReset: () => void;
export declare const noteReplaceRejected: () => void;
/** A plan threw mid-`apply()`: the in-memory partial mutation is not persisted (its journal record stays pending), and replay recovers it deterministically. */
export declare const noteApplyFailure: () => void;
/** An ingest declaration threw before or during apply: the event is reported through `onSyncError`, not silently dropped. */
export declare const noteIngestFailure: () => void;
/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
export declare const noteDataLoss: (mechanism: DataLossMechanism, model: string, count: number) => void;
export declare const snapshotDiagnostics: () => DiagnosticsState;
export declare const resetDiagnostics: () => void;
export {};
//# sourceMappingURL=diagnostics.d.ts.map