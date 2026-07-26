type DiagnosticsState = {
    commits: number;
    commitFanoutCandidates: number;
    commitFanoutNotified: number;
    fkIndexFullBuilds: number;
    fkIndexIncrementalUpdates: number;
    readEngineApplies: number;
    readEngineRebuilds: number;
    readEngineDeltaRows: number;
    mirrorScopePasses: number;
    mirrorScopeResorts: number;
    resumeDrains: number;
    resumeRefetches: number;
    totalReadEngineMs: number;
    totalMirrorMs: number;
    entityUpsertGuardHits: number;
    corruptionModelResets: number;
    corruptionJournalDrops: number;
    corruptionJournalLosses: number;
    corruptionLedgerResets: number;
    manifestResets: number;
    replaceRejected: number;
    applyFailure: number;
    ingestFailed: number;
};
export declare const noteCommit: () => void;
export declare const noteCommitFanout: (candidates: number, notified: number) => void;
export declare const noteFkIndex: (kind: "full" | "incremental", rows: number) => void;
export declare const noteReadEngineApply: (kind: "delta" | "rebuild", rows: number, ms: number) => void;
export declare const noteMirrorScopePass: (resorted: boolean, ms: number) => void;
export declare const noteResumeDrain: (refetched: number) => void;
export declare const noteEntityUpsertGuardHit: () => void;
export declare const noteCorruptionModelReset: () => void;
export declare const noteCorruptionJournalDrop: () => void;
export declare const noteCorruptionJournalLoss: () => void;
export declare const noteCorruptionLedgerReset: () => void;
export declare const noteManifestReset: () => void;
export declare const noteReplaceRejected: () => void;
/** A plan threw mid-`apply()`: the in-memory partial mutation is not persisted (its journal record stays pending), and replay recovers it deterministically. */
export declare const noteApplyFailure: () => void;
/** An ingest declaration threw before or during apply: the event is reported through `onSyncError`, not silently dropped. */
export declare const noteIngestFailure: () => void;
export declare const snapshotDiagnostics: () => DiagnosticsState;
export declare const resetDiagnostics: () => void;
export {};
//# sourceMappingURL=diagnostics.d.ts.map