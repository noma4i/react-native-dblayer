import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type DiagnosticsSnapshot = {
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

type DiagnosticsGlobal = { snapshot: () => DiagnosticsSnapshot; reset: () => void };

const diagnostics = (): DiagnosticsGlobal => (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as DiagnosticsGlobal;

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
      items.insertStored({ id: 'row-1', status: 'ready', score: 1 });
      items.insertStored({ id: 'row-2', status: 'ready', score: 2 });
    });

    const snapshot = diagnostics().snapshot();
    expect(snapshot.commits).toBeGreaterThan(0);
    expect(snapshot.readEngineApplies).toBeGreaterThan(0);
    reader.unmount();
  });

  it('separates delta rows from replace rebuilds', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const items = createItems('Modes');
    const reader = renderCounted(() => items.use.where({ status: 'ready' }).rows());

    act(() => {
      items.insertStored({ id: 'row-1', status: 'ready', score: 1 });
    });
    const delta = diagnostics().snapshot();
    expect(delta.readEngineDeltaRows).toBeGreaterThan(0);
    expect(delta.readEngineRebuilds).toBe(0);
    act(() => {
      items.replaceRaw('row-1', { id: 'row-2', status: 'ready', score: 2 });
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
      items.insertStored({ id: 'row-1', status: 'ready', score: 1 });
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
      mirrorScopePasses: 0,
      mirrorScopeResorts: 0,
      resumeDrains: 0,
      resumeRefetches: 0,
      totalReadEngineMs: 0,
      totalMirrorMs: 0
    });
  });

  it('exposes isolated snapshots through the device global', () => {
    setupSpecRuntime();
    diagnostics().reset();
    const items = createItems('Global');
    act(() => {
      items.insertStored({ id: 'row-1', status: 'ready', score: 1 });
    });

    const snapshot = diagnostics().snapshot();
    snapshot.commits = 999;

    expect((globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__).toBeDefined();
    expect(diagnostics().snapshot().commits).not.toBe(999);
  });
});
