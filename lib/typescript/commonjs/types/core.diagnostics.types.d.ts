export type DataLossMechanism = 'deferred-patch-timeout' | 'scope-retention-trim' | 'scope-complete-detach' | 'stale-temp-row-expiry' | 'tombstone-expiry' | 'corrupt-row' | 'corrupt-tombstones' | 'corrupt-scope' | 'failed-input-unserializable' | 'data-version-migration-reset' | 'schema-migration-reset' | 'model-corruption-recovery' | 'operation-ledger-corruption-reset' | 'operation-ledger-stale-version-reset' | 'corrupt-once-keys' | 'replacement-rejected' | 'orphan-membership-dropped' | 'unranked-ladder-value' | 'user-reset-discard' | 'fsck-scope-detach';
export type DataLossEvent = {
    mechanism: DataLossMechanism;
    model: string;
    count: number;
};
/** Mutable work-counter state behind `__DBLAYER_DIAGNOSTICS__`. */
export type DiagnosticsState = {
    commits: number;
    commitFanoutCandidates: number;
    commitFanoutNotified: number;
    readEngineApplies: number;
    readEngineDeltaRows: number;
    readEngineScanRows: number;
    scopeReadPasses: number;
    scopeReadResorts: number;
    resumeDrains: number;
    resumeRefetches: number;
    entityUpsertGuardHits: number;
    membershipWrites: number;
    relationChildScans: number;
    corruptionLedgerResets: number;
    manifestResets: number;
    replaceRejected: number;
    applyFailure: number;
    quarantinePuts: number;
    dataLossEvents: DataLossEvent[];
};
//# sourceMappingURL=core.diagnostics.types.d.ts.map