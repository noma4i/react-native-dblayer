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
};
export declare const noteCommit: () => void;
export declare const noteCommitFanout: (candidates: number, notified: number) => void;
export declare const noteFkIndex: (kind: "full" | "incremental", rows: number) => void;
export declare const noteReadEngineApply: (kind: "delta" | "rebuild", rows: number, ms: number) => void;
export declare const noteMirrorScopePass: (resorted: boolean, ms: number) => void;
export declare const noteResumeDrain: (refetched: number) => void;
export declare const snapshotDiagnostics: () => DiagnosticsState;
export declare const resetDiagnostics: () => void;
export {};
//# sourceMappingURL=diagnostics.d.ts.map