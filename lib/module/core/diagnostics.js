"use strict";

import { registerReset } from "./reset.js";
const emptyDiagnostics = () => ({
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
  corruptionJournalDrops: 0,
  corruptionJournalLosses: 0,
  corruptionLedgerResets: 0,
  manifestResets: 0,
  replaceRejected: 0,
  applyFailure: 0,
  dataLossEvents: []
});
let diagnostics = emptyDiagnostics();
export const noteCommit = () => {
  diagnostics.commits += 1;
};
export const noteCommitFanout = (candidates, notified) => {
  diagnostics.commitFanoutCandidates += candidates;
  diagnostics.commitFanoutNotified += notified;
};

/** One incremental update of a declared query, sized by the rows it moved. */
export const noteReadEngineApply = rows => {
  diagnostics.readEngineApplies += 1;
  diagnostics.readEngineDeltaRows += rows;
};

/** Record one model-read scan by its row count, without per-row instrumentation. */
export const noteReadEngineScan = rows => {
  diagnostics.readEngineScanRows += rows;
};
export const noteScopeReadPass = resorted => {
  diagnostics.scopeReadPasses += 1;
  if (resorted) diagnostics.scopeReadResorts += 1;
};
export const noteResumeDrain = refetched => {
  diagnostics.resumeDrains += 1;
  diagnostics.resumeRefetches += refetched;
};
export const noteEntityUpsertGuardHit = () => {
  diagnostics.entityUpsertGuardHits += 1;
};

/** Count membership feed messages actually written - the work-counter behind same-pairs replaceAll staying at zero. */
export const noteRelationChildScan = () => {
  diagnostics.relationChildScans += 1;
};
export const noteMembershipWrites = count => {
  diagnostics.membershipWrites += count;
};
export const noteCorruptionJournalDrop = () => {
  diagnostics.corruptionJournalDrops += 1;
};
export const noteCorruptionJournalLoss = () => {
  diagnostics.corruptionJournalLosses += 1;
};
export const noteCorruptionLedgerReset = () => {
  diagnostics.corruptionLedgerResets += 1;
};

/** Count cold resets caused by an incompatible persistence manifest. */
export const noteManifestReset = () => {
  diagnostics.manifestResets += 1;
};
export const noteReplaceRejected = () => {
  diagnostics.replaceRejected += 1;
};

/** A plan failed both its initial atomic apply and clean retry; its WAL stays pending and reads remain poisoned. */
export const noteApplyFailure = () => {
  diagnostics.applyFailure += 1;
};

/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
export const noteDataLoss = (mechanism, model, count) => {
  if (count <= 0) return;
  diagnostics.dataLossEvents.push({
    mechanism,
    model,
    count
  });
  if (diagnostics.dataLossEvents.length > 100) diagnostics.dataLossEvents.splice(0, diagnostics.dataLossEvents.length - 100);
};
const snapshotDiagnostics = () => ({
  ...diagnostics,
  dataLossEvents: [...diagnostics.dataLossEvents]
});
const resetDiagnostics = () => {
  diagnostics = emptyDiagnostics();
};
registerReset(resetDiagnostics);
globalThis.__DBLAYER_DIAGNOSTICS__ = {
  snapshot: snapshotDiagnostics,
  reset: resetDiagnostics
};
//# sourceMappingURL=diagnostics.js.map