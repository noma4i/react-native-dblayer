import { act } from 'react';
import { defineModelRuntime, f, noteDataLoss, resetRuntime } from '../../testApi';
import { renderCounted, setupSpecRuntime, diagnostics } from '../helpers/harness';

const createItems = (suffix: string) =>
  defineModelRuntime({
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

  it('delivers a replace as a delta instead of recomputing the result', () => {
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
    act(() => {
      items.replace('row-1', { id: 'row-2', status: 'ready', score: 2 });
    });

    // Identity replace reaches the reader as ordinary deltas: no read path recomputes a whole result.
    const afterReplace = diagnostics().snapshot();
    expect(afterReplace.readEngineDeltaRows).toBeGreaterThan(delta.readEngineDeltaRows);
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
      readEngineApplies: 0,
      readEngineDeltaRows: 0,
      readEngineScanRows: 0,
      relationChildScans: 0,
      scopeReadPasses: 0,
      scopeReadResorts: 0,
      replaceRejected: 0,
      resumeDrains: 0,
      resumeRefetches: 0,
      entityUpsertGuardHits: 0,
      membershipWrites: 0,
      corruptionLedgerResets: 0,
      manifestResets: 0,
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

  it('ignores empty loss reports and retains only the newest one hundred events', () => {
    setupSpecRuntime();
    diagnostics().reset();
    noteDataLoss('scope-retention-trim', 'Rows', 0);
    for (let index = 0; index < 105; index += 1) noteDataLoss('scope-retention-trim', `Rows${index}`, 1);

    const events = diagnostics().snapshot().dataLossEvents;
    expect(events).toHaveLength(100);
    expect(events[0]).toEqual({ mechanism: 'scope-retention-trim', model: 'Rows5', count: 1 });
    expect(events.at(-1)).toEqual({ mechanism: 'scope-retention-trim', model: 'Rows104', count: 1 });
  });
});
