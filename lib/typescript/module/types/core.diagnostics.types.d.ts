export type DataLossMechanism = 'scope-retention-trim' | 'scope-complete-detach' | 'stale-temp-row-expiry' | 'tombstone-expiry' | 'corrupt-row' | 'corrupt-tombstones' | 'corrupt-scope' | 'data-version-migration-reset' | 'schema-migration-reset' | 'model-corruption-recovery' | 'corrupt-once-keys' | 'replacement-rejected' | 'unranked-ladder-value' | 'user-reset-discard' | 'delta-tail-cut' | 'query-record-fingerprint-reset' | 'subscription-payload-mismatch' | 'quarantine-evicted' | 'maintenance-rows-trim';
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
    tombstoneWriteDrops: number;
    chainSurvivorShrinks: number;
    membershipMissingEntity: number;
    counterOpDrops: number;
    nonResidentTouchDrops: number;
    unknownOperationAcks: number;
    causalAdmissionDrops: number;
    dataLossEvents: DataLossEvent[];
};
//# sourceMappingURL=core.diagnostics.types.d.ts.map