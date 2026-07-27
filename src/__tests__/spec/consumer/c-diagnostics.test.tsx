import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime } from '../../../index';
import { renderCounted, setupSpecRuntime, diagnostics } from '../helpers/harness';

const createItems = (suffix: string) =>
  defineModel({
    id: `SpecDiagnostics${suffix}`,
    name: `SpecDiagnostics${suffix}`,
    fields: { id: f.str(), status: f.str(), score: f.num() }
  });

describe('read diagnostics', () => {
  it('records commits and read-engine applies for mounted where readers', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const items = createItems('Commits');
    const reader = renderCounted(() => items.use.where({ status: 'ready' }).rows());

    act(() => {
      items.insert({ id: 'row-1', status: 'ready', score: 1 });
      items.insert({ id: 'row-2', status: 'ready', score: 2 });
    });

    const snapshot = diagnostics().snapshot();
    // Each insert emits one commit and applies one row delta to the mounted where reader.
    expect(snapshot.commits).toBe(2);
    expect(snapshot.readEngineApplies).toBe(2);
    reader.unmount();
  });

  it('separates delta rows from replace rebuilds', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const items = createItems('Modes');
    const reader = renderCounted(() => items.use.where({ status: 'ready' }).rows());

    act(() => {
      items.insert({ id: 'row-1', status: 'ready', score: 1 });
    });
    const delta = diagnostics().snapshot();
    // The one inserted row reaches the delta read-engine path once.
    expect(delta.readEngineDeltaRows).toBe(1);
    expect(delta.readEngineRebuilds).toBe(0);
    act(() => {
      items.replace('row-1', { id: 'row-2', status: 'ready', score: 2 });
    });

    expect(diagnostics().snapshot().readEngineRebuilds).toBeGreaterThan(0);
    reader.unmount();
  });

  it('clears diagnostics on resetRuntime', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const items = createItems('Reset');
    const reader = renderCounted(() => items.use.where({ status: 'ready' }).rows());
    act(() => {
      items.insert({ id: 'row-1', status: 'ready', score: 1 });
    });
    reader.unmount();

    resetRuntime();

    expect(diagnostics().snapshot()).toEqual({
      commits: 0,
      commitFanoutCandidates: 0,
      commitFanoutNotified: 0,
      fkIndexFullBuilds: 0,
      fkIndexIncrementalUpdates: 0,
      readEngineApplies: 0,
      readEngineRebuilds: 0,
      readEngineDeltaRows: 0,
      readEngineScanRows: 0,
      mirrorScopePasses: 0,
      mirrorScopeResorts: 0,
      replaceRejected: 0,
      resumeDrains: 0,
      resumeRefetches: 0,
      totalReadEngineMs: 0,
      totalMirrorMs: 0,
      entityUpsertGuardHits: 0,
      corruptionJournalDrops: 0,
      corruptionJournalLosses: 0,
      corruptionLedgerResets: 0,
      scopeKeyMigrations: 0,
      manifestResets: 0,
      applyFailure: 0,
      ingestFailed: 0,
      dataLossEvents: []
    });
  });

  it('exposes isolated snapshots through the device global', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const items = createItems('Global');
    act(() => {
      items.insert({ id: 'row-1', status: 'ready', score: 1 });
    });

    const snapshot = diagnostics().snapshot();
    snapshot.commits = 999;

    expect((globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__).toBeDefined();
    expect(diagnostics().snapshot().commits).not.toBe(999);
  });
});
