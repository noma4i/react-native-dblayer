import { registerReset } from './reset';

type DiagnosticsState = {
  commits: number;
  commitFanoutCandidates: number;
  commitFanoutNotified: number;
  fkIndexFullBuilds: number;
  fkIndexIncrementalUpdates: number;
  readEngineApplies: number;
  readEngineRebuilds: number;
  readEngineDeltaRows: number;
  mirrorScopePasses: number;
  mirrorScopeResorts: number;
  resumeDrains: number;
  resumeRefetches: number;
  totalReadEngineMs: number;
  totalMirrorMs: number;
};

const emptyDiagnostics = (): DiagnosticsState => ({
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
  totalMirrorMs: 0
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

export const noteReadEngineApply = (kind: 'delta' | 'rebuild', rows: number, ms: number): void => {
  diagnostics.readEngineApplies += 1;
  if (kind === 'rebuild') diagnostics.readEngineRebuilds += 1;
  else diagnostics.readEngineDeltaRows += rows;
  diagnostics.totalReadEngineMs += ms;
};

export const noteMirrorScopePass = (resorted: boolean, ms: number): void => {
  diagnostics.mirrorScopePasses += 1;
  if (resorted) diagnostics.mirrorScopeResorts += 1;
  diagnostics.totalMirrorMs += ms;
};

export const noteResumeDrain = (refetched: number): void => {
  diagnostics.resumeDrains += 1;
  diagnostics.resumeRefetches += refetched;
};

export const snapshotDiagnostics = (): DiagnosticsState => ({ ...diagnostics });

export const resetDiagnostics = (): void => {
  diagnostics = emptyDiagnostics();
};

registerReset(resetDiagnostics);

(globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ = { snapshot: snapshotDiagnostics, reset: resetDiagnostics };
