import { registerReset } from './reset';
import type { CausalAdmissionDropEvent, DataLossMechanism, DiagnosticsState } from '../types';


const emptyDiagnostics = (): DiagnosticsState => ({
  commits: 0,
  commitFanoutCandidates: 0,
  commitFanoutNotified: 0,
  readEngineApplies: 0,
  readEngineDeltaRows: 0,
  readEngineScanRows: 0,
  scopeReadPasses: 0,
  scopeReadResorts: 0,
  resumeDrains: 0,
  resumeRefetches: 0,
  entityUpsertGuardHits: 0,
  membershipWrites: 0,
  relationChildScans: 0,
  corruptionLedgerResets: 0,
  manifestResets: 0,
  replaceRejected: 0,
  applyFailure: 0,
  quarantinePuts: 0,
  tombstoneWriteDrops: 0,
  chainSurvivorShrinks: 0,
  membershipMissingEntity: 0,
  counterOpDrops: 0,
  nonResidentTouchDrops: 0,
  unknownOperationAcks: 0,
  causalAdmissionDrops: 0,
  causalAdmissionDropEvents: [],
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

/** One incremental update of a declared query, sized by the rows it moved. */
export const noteReadEngineApply = (rows: number): void => {
  diagnostics.readEngineApplies += 1;
  diagnostics.readEngineDeltaRows += rows;
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
export const noteRelationChildScan = (): void => {
  diagnostics.relationChildScans += 1;
};

export const noteMembershipWrites = (count: number): void => {
  diagnostics.membershipWrites += count;
};

export const noteCorruptionLedgerReset = (): void => {
  diagnostics.corruptionLedgerResets += 1;
};

/** Count cold resets caused by an incompatible persistence manifest. */
export const noteManifestReset = (): void => {
  diagnostics.manifestResets += 1;
};

export const noteReplaceRejected = (): void => {
  diagnostics.replaceRejected += 1;
};

/** A plan failed both its initial atomic apply and clean retry; reads remain poisoned. */
export const noteApplyFailure = (): void => {
  diagnostics.applyFailure += 1;
};

/** Count payloads kept in the quarantine instead of being dropped. */
export const noteQuarantinePut = (): void => {
  diagnostics.quarantinePuts += 1;
};

/** Count landings gated out by a live tombstone - the discriminator for vanished-window defects. */
export const noteTombstoneWriteDrop = (): void => {
  diagnostics.tombstoneWriteDrops += 1;
};

/** Count query chains shrunk by materialization loss while survivors remain. */
export const noteChainSurvivorShrink = (): void => {
  diagnostics.chainSurvivorShrinks += 1;
};

/** Count scope members whose entity row is absent at read time - must stay 0 after boot fsck. */
export const noteMembershipMissingEntity = (count: number): void => {
  if (count > 0) diagnostics.membershipMissingEntity += count;
};

/** Count counter ops skipped for a non-resident parent or non-numeric base. */
export const noteCounterOpDrop = (): void => {
  diagnostics.counterOpDrops += 1;
};

/** Count touch effects dropped because the parent row is not resident in the plan. */
export const noteNonResidentTouchDrop = (): void => {
  diagnostics.nonResidentTouchDrops += 1;
};

/** Count terminal ledger acks aimed at an unknown or already-closed operation. */
export const noteUnknownOperationAck = (): void => {
  diagnostics.unknownOperationAcks += 1;
};

/** Count rows or fields evicted by causal admission (stale baseRevision against newer committed state), with a bounded record of what was evicted. */
export const noteCausalAdmissionDrop = (event: CausalAdmissionDropEvent): void => {
  diagnostics.causalAdmissionDrops += 1;
  diagnostics.causalAdmissionDropEvents.push(event);
  if (diagnostics.causalAdmissionDropEvents.length > 100) diagnostics.causalAdmissionDropEvents.splice(0, diagnostics.causalAdmissionDropEvents.length - 100);
};

/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
export const noteDataLoss = (mechanism: DataLossMechanism, model: string, count: number): void => {
  if (count <= 0) return;
  diagnostics.dataLossEvents.push({ mechanism, model, count });
  if (diagnostics.dataLossEvents.length > 100) diagnostics.dataLossEvents.splice(0, diagnostics.dataLossEvents.length - 100);
};

const snapshotDiagnostics = (): DiagnosticsState => ({ ...diagnostics, causalAdmissionDropEvents: [...diagnostics.causalAdmissionDropEvents], dataLossEvents: [...diagnostics.dataLossEvents] });

const resetDiagnostics = (): void => {
  diagnostics = emptyDiagnostics();
};

registerReset(resetDiagnostics);

(globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ = { snapshot: snapshotDiagnostics, reset: resetDiagnostics };
