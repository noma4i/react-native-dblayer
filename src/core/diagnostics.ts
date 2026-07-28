import { registerReset } from './reset';
import type { DataLossMechanism, DiagnosticsState } from '../types';


const emptyDiagnostics = (): DiagnosticsState => ({
  commits: 0,
  commitFanoutCandidates: 0,
  commitFanoutNotified: 0,
  fkIndexFullBuilds: 0,
  fkIndexIncrementalUpdates: 0,
  readEngineApplies: 0,
  readEngineRebuilds: 0,
  readEngineDeltaRows: 0,
  readEngineScanRows: 0,
  scopeReadPasses: 0,
  scopeReadResorts: 0,
  resumeDrains: 0,
  resumeRefetches: 0,
  entityUpsertGuardHits: 0,
  membershipWrites: 0,
  corruptionJournalDrops: 0,
  corruptionJournalLosses: 0,
  corruptionLedgerResets: 0,
  manifestResets: 0,
  replaceRejected: 0,
  applyFailure: 0,
  ingestFailed: 0,
  dataLossEvents: []
});

let diagnostics = emptyDiagnostics();

export const noteCommit = (): void => {
  diagnostics.commits += 1;
};

export const noteCommitFanout = (candidates: number, notified: number): void => {
  diagnostics.commitFanoutCandidates += candidates;
  diagnostics.commitFanoutNotified += notified;
};

export const noteFkIndex = (kind: 'full' | 'incremental', rows: number): void => {
  if (kind === 'full') diagnostics.fkIndexFullBuilds += 1;
  else diagnostics.fkIndexIncrementalUpdates += rows;
};

export const noteReadEngineApply = (kind: 'delta' | 'rebuild', rows: number): void => {
  diagnostics.readEngineApplies += 1;
  if (kind === 'rebuild') diagnostics.readEngineRebuilds += 1;
  else diagnostics.readEngineDeltaRows += rows;
};

/** Record one model-read scan by its row count, without per-row instrumentation. */
export const noteReadEngineScan = (rows: number): void => {
  diagnostics.readEngineScanRows += rows;
};

export const noteScopeReadPass = (resorted: boolean): void => {
  diagnostics.scopeReadPasses += 1;
  if (resorted) diagnostics.scopeReadResorts += 1;
};

export const noteResumeDrain = (refetched: number): void => {
  diagnostics.resumeDrains += 1;
  diagnostics.resumeRefetches += refetched;
};

export const noteEntityUpsertGuardHit = (): void => {
  diagnostics.entityUpsertGuardHits += 1;
};

/** Count membership feed messages actually written - the work-counter behind same-pairs replaceAll staying at zero. */
export const noteMembershipWrites = (count: number): void => {
  diagnostics.membershipWrites += count;
};

export const noteCorruptionJournalDrop = (): void => {
  diagnostics.corruptionJournalDrops += 1;
};

export const noteCorruptionJournalLoss = (): void => {
  diagnostics.corruptionJournalLosses += 1;
};

export const noteCorruptionLedgerReset = (): void => {
  diagnostics.corruptionLedgerResets += 1;
};

/** Count persisted scope keys rewritten from the colon-delimited format. */
export const noteManifestReset = (): void => {
  diagnostics.manifestResets += 1;
};

export const noteReplaceRejected = (): void => {
  diagnostics.replaceRejected += 1;
};

/** A plan threw mid-`apply()`: the in-memory partial mutation is not persisted (its journal record stays pending), and replay recovers it deterministically. */
export const noteApplyFailure = (): void => {
  diagnostics.applyFailure += 1;
};

/** An ingest declaration threw before or during apply: the event is reported through `onSyncError`, not silently dropped. */
export const noteIngestFailure = (): void => {
  diagnostics.ingestFailed += 1;
};

/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
export const noteDataLoss = (mechanism: DataLossMechanism, model: string, count: number): void => {
  if (count <= 0) return;
  diagnostics.dataLossEvents.push({ mechanism, model, count });
  if (diagnostics.dataLossEvents.length > 100) diagnostics.dataLossEvents.splice(0, diagnostics.dataLossEvents.length - 100);
};

const snapshotDiagnostics = (): DiagnosticsState => ({ ...diagnostics, dataLossEvents: [...diagnostics.dataLossEvents] });

const resetDiagnostics = (): void => {
  diagnostics = emptyDiagnostics();
};

registerReset(resetDiagnostics);

(globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ = { snapshot: snapshotDiagnostics, reset: resetDiagnostics };
