import { diagnosticsModule } from '../../testApi';
import type { DiagnosticsState } from '../../testApi';
import { diagnostics, setupSpecRuntime } from '../helpers/harness';

type CounterName = {
  [Key in keyof DiagnosticsState]: DiagnosticsState[Key] extends number ? Key : never;
}[keyof DiagnosticsState];

const read = (counter: CounterName): number => diagnostics().snapshot()[counter];

/**
 * Owner contract of the instrumentation. Every perf gate in the suite reads these counters, so a
 * counter that moves by the wrong amount - or not at all - silently rewrites the verdict of every
 * test built on it. Each case states the exact delta one call produces, because a test that only
 * checks "the counter is non-zero" cannot tell an increment from a decrement.
 */
describe('diagnostics counters', () => {
  beforeEach(() => {
    setupSpecRuntime();
    diagnostics().reset();
  });

  it('counts one commit per call', () => {
    diagnosticsModule.noteCommit();
    diagnosticsModule.noteCommit();

    expect(read('commits')).toBe(2);
  });

  it('records fanout candidates and notified separately', () => {
    diagnosticsModule.noteCommitFanout(7, 2);

    expect(read('commitFanoutCandidates')).toBe(7);
    expect(read('commitFanoutNotified')).toBe(2);
  });

  it('counts a full fk index build as one build and an incremental one by its rows', () => {
    diagnosticsModule.noteFkIndex('full', 40);
    diagnosticsModule.noteFkIndex('incremental', 3);

    expect(read('fkIndexFullBuilds')).toBe(1);
    expect(read('fkIndexIncrementalUpdates')).toBe(3);
  });

  it('counts one read engine apply and its moved rows', () => {
    diagnosticsModule.noteReadEngineApply(5);
    diagnosticsModule.noteReadEngineApply(2);

    expect(read('readEngineApplies')).toBe(2);
    expect(read('readEngineDeltaRows')).toBe(7);
  });

  it('sizes a read engine scan by its rows without counting an apply', () => {
    diagnosticsModule.noteReadEngineScan(9);

    expect(read('readEngineScanRows')).toBe(9);
    expect(read('readEngineApplies')).toBe(0);
  });

  it('counts a scope read pass always and a resort only when the order moved', () => {
    diagnosticsModule.noteScopeReadPass(false);
    diagnosticsModule.noteScopeReadPass(true);

    expect(read('scopeReadPasses')).toBe(2);
    expect(read('scopeReadResorts')).toBe(1);
  });

  it('counts one resume drain and the refetches it carried', () => {
    diagnosticsModule.noteResumeDrain(4);

    expect(read('resumeDrains')).toBe(1);
    expect(read('resumeRefetches')).toBe(4);
  });

  it('counts membership writes by their number, not by call', () => {
    diagnosticsModule.noteMembershipWrites(6);
    diagnosticsModule.noteMembershipWrites(1);

    expect(read('membershipWrites')).toBe(7);
  });

  it('counts one event per call for every single-shot counter', () => {
    const singleShot: Array<[() => void, CounterName]> = [
      [diagnosticsModule.noteEntityUpsertGuardHit, 'entityUpsertGuardHits'],
      [diagnosticsModule.noteRelationChildScan, 'relationChildScans'],
      [diagnosticsModule.noteCorruptionJournalDrop, 'corruptionJournalDrops'],
      [diagnosticsModule.noteCorruptionJournalLoss, 'corruptionJournalLosses'],
      [diagnosticsModule.noteCorruptionLedgerReset, 'corruptionLedgerResets'],
      [diagnosticsModule.noteManifestReset, 'manifestResets'],
      [diagnosticsModule.noteReplaceRejected, 'replaceRejected'],
      [diagnosticsModule.noteApplyFailure, 'applyFailure'],
      [diagnosticsModule.noteIngestFailure, 'ingestFailed']
    ];

    for (const [note] of singleShot) note();

    expect(singleShot.map(([, counter]) => [counter, read(counter)])).toEqual(singleShot.map(([, counter]) => [counter, 1]));
  });

  it('keeps a data loss record only for a positive count and bounds the log', () => {
    diagnosticsModule.noteDataLoss('gc-row-eviction', 'Spec', 0);
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);

    diagnosticsModule.noteDataLoss('gc-row-eviction', 'Spec', 2);
    expect(diagnostics().snapshot().dataLossEvents).toEqual([{ mechanism: 'gc-row-eviction', model: 'Spec', count: 2 }]);

    for (let index = 0; index < 120; index += 1) diagnosticsModule.noteDataLoss('gc-row-eviction', `Spec${index}`, 1);
    const events = diagnostics().snapshot().dataLossEvents;

    expect(events).toHaveLength(100);
    expect(events[events.length - 1]).toEqual({ mechanism: 'gc-row-eviction', model: 'Spec119', count: 1 });
  });
});
