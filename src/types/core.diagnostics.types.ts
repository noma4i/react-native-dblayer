export type DataLossMechanism =
  | 'deferred-patch-timeout'
  | 'scope-retention-trim'
  | 'scope-complete-detach'
  | 'stale-temp-row-expiry'
  | 'tombstone-expiry'
  | 'corrupt-row'
  | 'corrupt-tombstones'
  | 'corrupt-scope'
  | 'corrupt-applied-epoch'
  | 'corrupt-checkpoint-meta'
  | 'failed-input-unserializable'
  | 'detached-operation-discard'
  | 'detached-operation-rollback'
  | 'detached-resume-error'
  | 'data-version-migration-reset'
  | 'model-corruption-recovery'
  | 'journal-corruption-checkpointed-drop'
  | 'journal-corruption-loss'
  | 'operation-ledger-corruption-reset'
  | 'corrupt-once-keys'
  | 'replacement-rejected'
  | 'unranked-ladder-value';

export type DataLossEvent = { mechanism: DataLossMechanism; model: string; count: number };

/** Mutable work-counter state behind `__DBLAYER_DIAGNOSTICS__`. */
export type DiagnosticsState = {
  commits: number;
  commitFanoutCandidates: number;
  commitFanoutNotified: number;
  fkIndexFullBuilds: number;
  fkIndexIncrementalUpdates: number;
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
  corruptionJournalDrops: number;
  corruptionJournalLosses: number;
  corruptionLedgerResets: number;
  manifestResets: number;
  replaceRejected: number;
  applyFailure: number;
  ingestFailed: number;
  dataLossEvents: DataLossEvent[];
};
