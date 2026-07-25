"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.snapshotDiagnostics = exports.resetDiagnostics = exports.noteResumeDrain = exports.noteReadEngineApply = exports.noteMirrorScopePass = exports.noteFkIndex = exports.noteEntityUpsertGuardHit = exports.noteCommitFanout = exports.noteCommit = void 0;
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
  entityUpsertGuardHits: 0
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