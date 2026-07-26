"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.snapshotDiagnostics = exports.resetDiagnostics = exports.noteResumeDrain = exports.noteReplaceRejected = exports.noteReadEngineApply = exports.noteMirrorScopePass = exports.noteManifestReset = exports.noteIngestFailure = exports.noteFkIndex = exports.noteEntityUpsertGuardHit = exports.noteCorruptionModelReset = exports.noteCorruptionLedgerReset = exports.noteCorruptionJournalLoss = exports.noteCorruptionJournalDrop = exports.noteCommitFanout = exports.noteCommit = exports.noteApplyFailure = void 0;
var _reset = require("./reset.js");
const emptyDiagnostics = () => ({
  commits: 0,
  commitFanoutCandidates: 0,
  commitFanoutNotified: 0,
  fkIndexFullBuilds: 0,
  fkIndexIncrementalUpdates: 0,
  readEngineApplies: 0,
  readEngineRebuilds: 0,
  readEngineDeltaRows: 0,
  mirrorScopePasses: 0,
  mirrorScopeResorts: 0,
  resumeDrains: 0,
  resumeRefetches: 0,
  totalReadEngineMs: 0,
  totalMirrorMs: 0,
  entityUpsertGuardHits: 0,
  corruptionModelResets: 0,
  corruptionJournalDrops: 0,
  corruptionJournalLosses: 0,
  corruptionLedgerResets: 0,
  manifestResets: 0,
  replaceRejected: 0,
  applyFailure: 0,
  ingestFailed: 0
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
exports.noteFkIndex = noteFkIndex;
const noteReadEngineApply = (kind, rows, ms) => {
  diagnostics.readEngineApplies += 1;
  if (kind === 'rebuild') diagnostics.readEngineRebuilds += 1;else diagnostics.readEngineDeltaRows += rows;
  diagnostics.totalReadEngineMs += ms;
};
exports.noteReadEngineApply = noteReadEngineApply;
const noteMirrorScopePass = (resorted, ms) => {
  diagnostics.mirrorScopePasses += 1;
  if (resorted) diagnostics.mirrorScopeResorts += 1;
  diagnostics.totalMirrorMs += ms;
};
exports.noteMirrorScopePass = noteMirrorScopePass;
const noteResumeDrain = refetched => {
  diagnostics.resumeDrains += 1;
  diagnostics.resumeRefetches += refetched;
};
exports.noteResumeDrain = noteResumeDrain;
const noteEntityUpsertGuardHit = () => {
  diagnostics.entityUpsertGuardHits += 1;
};
exports.noteEntityUpsertGuardHit = noteEntityUpsertGuardHit;
const noteCorruptionModelReset = () => {
  diagnostics.corruptionModelResets += 1;
};
exports.noteCorruptionModelReset = noteCorruptionModelReset;
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
exports.noteCorruptionLedgerReset = noteCorruptionLedgerReset;
const noteManifestReset = () => {
  diagnostics.manifestResets += 1;
};
exports.noteManifestReset = noteManifestReset;
const noteReplaceRejected = () => {
  diagnostics.replaceRejected += 1;
};

/** A plan threw mid-`apply()`: the in-memory partial mutation is not persisted (its journal record stays pending), and replay recovers it deterministically. */
exports.noteReplaceRejected = noteReplaceRejected;
const noteApplyFailure = () => {
  diagnostics.applyFailure += 1;
};

/** An ingest declaration threw before or during apply: the event is reported through `onSyncError`, not silently dropped. */
exports.noteApplyFailure = noteApplyFailure;
const noteIngestFailure = () => {
  diagnostics.ingestFailed += 1;
};
exports.noteIngestFailure = noteIngestFailure;
const snapshotDiagnostics = () => ({
  ...diagnostics
});
exports.snapshotDiagnostics = snapshotDiagnostics;
const resetDiagnostics = () => {
  diagnostics = emptyDiagnostics();
};
exports.resetDiagnostics = resetDiagnostics;
(0, _reset.registerReset)(resetDiagnostics);
globalThis.__DBLAYER_DIAGNOSTICS__ = {
  snapshot: snapshotDiagnostics,
  reset: resetDiagnostics
};
//# sourceMappingURL=diagnostics.js.map