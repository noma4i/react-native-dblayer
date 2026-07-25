"use strict";

import { registerReset } from "./reset.js";
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
export const noteCommit = () => {
  diagnostics.commits += 1;
};
export const noteCommitFanout = (candidates, notified) => {
  diagnostics.commitFanoutCandidates += candidates;
  diagnostics.commitFanoutNotified += notified;
};
export const noteFkIndex = (kind, rows) => {
  if (kind === 'full') diagnostics.fkIndexFullBuilds += 1;else diagnostics.fkIndexIncrementalUpdates += rows;
};
export const noteReadEngineApply = (kind, rows, ms) => {
  diagnostics.readEngineApplies += 1;
  if (kind === 'rebuild') diagnostics.readEngineRebuilds += 1;else diagnostics.readEngineDeltaRows += rows;
  diagnostics.totalReadEngineMs += ms;
};
export const noteMirrorScopePass = (resorted, ms) => {
  diagnostics.mirrorScopePasses += 1;
  if (resorted) diagnostics.mirrorScopeResorts += 1;
  diagnostics.totalMirrorMs += ms;
};
export const noteResumeDrain = refetched => {
  diagnostics.resumeDrains += 1;
  diagnostics.resumeRefetches += refetched;
};
export const noteEntityUpsertGuardHit = () => {
  diagnostics.entityUpsertGuardHits += 1;
};
export const snapshotDiagnostics = () => ({
  ...diagnostics
});
export const resetDiagnostics = () => {
  diagnostics = emptyDiagnostics();
};
registerReset(resetDiagnostics);
globalThis.__DBLAYER_DIAGNOSTICS__ = {
  snapshot: snapshotDiagnostics,
  reset: resetDiagnostics
};
//# sourceMappingURL=diagnostics.js.map