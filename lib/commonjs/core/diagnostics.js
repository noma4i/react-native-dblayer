"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.noteScopeReadPass = exports.noteResumeDrain = exports.noteReplaceRejected = exports.noteRelationChildScan = exports.noteReadEngineScan = exports.noteReadEngineApply = exports.noteMembershipWrites = exports.noteManifestReset = exports.noteIngestFailure = exports.noteFkIndex = exports.noteEntityUpsertGuardHit = exports.noteDataLoss = exports.noteCorruptionLedgerReset = exports.noteCorruptionJournalLoss = exports.noteCorruptionJournalDrop = exports.noteCommitFanout = exports.noteCommit = exports.noteApplyFailure = void 0;
var _reset = require("./reset.js");
const emptyDiagnostics = () => ({
  commits: 0,
  commitFanoutCandidates: 0,
  commitFanoutNotified: 0,
  fkIndexFullBuilds: 0,
  fkIndexIncrementalUpdates: 0,
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
  ingestFailed: 0,
  dataLossEvents: []
});
let diagnostics = emptyDiagnostics();
const noteCommit = () => {
  diagnostics.commits += 1;
};
exports.noteCommit = noteCommit;
const noteCommitFanout = (candidates, notified) => {
  diagnostics.commitFanoutCandidates += candidates;
  diagnostics.commitFanoutNotified += notified;
};
exports.noteCommitFanout = noteCommitFanout;
const noteFkIndex = (kind, rows) => {
  if (kind === 'full') diagnostics.fkIndexFullBuilds += 1;else diagnostics.fkIndexIncrementalUpdates += rows;
};

/** One incremental update of a declared query, sized by the rows it moved. */
exports.noteFkIndex = noteFkIndex;
const noteReadEngineApply = rows => {
  diagnostics.readEngineApplies += 1;
  diagnostics.readEngineDeltaRows += rows;
};

/** Record one model-read scan by its row count, without per-row instrumentation. */
exports.noteReadEngineApply = noteReadEngineApply;
const noteReadEngineScan = rows => {
  diagnostics.readEngineScanRows += rows;
};
exports.noteReadEngineScan = noteReadEngineScan;
const noteScopeReadPass = resorted => {
  diagnostics.scopeReadPasses += 1;
  if (resorted) diagnostics.scopeReadResorts += 1;
};
exports.noteScopeReadPass = noteScopeReadPass;
const noteResumeDrain = refetched => {
  diagnostics.resumeDrains += 1;
  diagnostics.resumeRefetches += refetched;
};
exports.noteResumeDrain = noteResumeDrain;
const noteEntityUpsertGuardHit = () => {
  diagnostics.entityUpsertGuardHits += 1;
};

/** Count membership feed messages actually written - the work-counter behind same-pairs replaceAll staying at zero. */
exports.noteEntityUpsertGuardHit = noteEntityUpsertGuardHit;
const noteRelationChildScan = () => {
  diagnostics.relationChildScans += 1;
};
exports.noteRelationChildScan = noteRelationChildScan;
const noteMembershipWrites = count => {
  diagnostics.membershipWrites += count;
};
exports.noteMembershipWrites = noteMembershipWrites;
const noteCorruptionJournalDrop = () => {
  diagnostics.corruptionJournalDrops += 1;
};
exports.noteCorruptionJournalDrop = noteCorruptionJournalDrop;
const noteCorruptionJournalLoss = () => {
  diagnostics.corruptionJournalLosses += 1;
};
exports.noteCorruptionJournalLoss = noteCorruptionJournalLoss;
const noteCorruptionLedgerReset = () => {
  diagnostics.corruptionLedgerResets += 1;
};

/** Count cold resets caused by an incompatible persistence manifest. */
exports.noteCorruptionLedgerReset = noteCorruptionLedgerReset;
const noteManifestReset = () => {
  diagnostics.manifestResets += 1;
};
exports.noteManifestReset = noteManifestReset;
const noteReplaceRejected = () => {
  diagnostics.replaceRejected += 1;
};

/** A plan failed both its initial atomic apply and clean retry; its WAL stays pending and reads remain poisoned. */
exports.noteReplaceRejected = noteReplaceRejected;
const noteApplyFailure = () => {
  diagnostics.applyFailure += 1;
};

/** An ingest declaration threw before or during apply: the event is reported through `onSyncError`, not silently dropped. */
exports.noteApplyFailure = noteApplyFailure;
const noteIngestFailure = () => {
  diagnostics.ingestFailed += 1;
};

/** Append a bounded, inspectable record whenever a row, membership, guard, or operation is discarded. */
exports.noteIngestFailure = noteIngestFailure;
const noteDataLoss = (mechanism, model, count) => {
  if (count <= 0) return;
  diagnostics.dataLossEvents.push({
    mechanism,
    model,
    count
  });
  if (diagnostics.dataLossEvents.length > 100) diagnostics.dataLossEvents.splice(0, diagnostics.dataLossEvents.length - 100);
};
exports.noteDataLoss = noteDataLoss;
const snapshotDiagnostics = () => ({
  ...diagnostics,
  dataLossEvents: [...diagnostics.dataLossEvents]
});
const resetDiagnostics = () => {
  diagnostics = emptyDiagnostics();
};
(0, _reset.registerReset)(resetDiagnostics);
globalThis.__DBLAYER_DIAGNOSTICS__ = {
  snapshot: snapshotDiagnostics,
  reset: resetDiagnostics
};
//# sourceMappingURL=diagnostics.js.map