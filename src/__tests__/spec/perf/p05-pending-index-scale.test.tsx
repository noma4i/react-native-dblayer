import { act } from 'react';
import { defineModelRuntime, f, resetRuntime , createCommitEnvelope , getApplyRuntime, getOperationState } from '../../testApi';
import type { OperationRecord, OperationTransition } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

const TARGET_MODEL = 'SpecPendingIndexTarget';
const TARGET_ROW = 'target-row';
const ACTION_OWNER = { actionKey: 'SpecPendingIndex:action', actionMode: 'request' as const };

const seedForeignOps = (count: number): void => {
  const transitions: OperationTransition[] = [];
  for (let index = 0; index < count; index += 1) {
    transitions.push({
      kind: 'begin',
      operation: {
        ...ACTION_OWNER,
        operationId: `foreign-${index}`,
        model: 'SpecPendingIndexForeign',
        tempIds: [],
        rowIds: [`foreign-row-${index}`],
        intent: 'patch',
        patchedFields: ['score'],
        patchedValues: { score: index },
        createdAt: index
      }
    });
  }
  getApplyRuntime().commit(createCommitEnvelope([], transitions));
};

const seedTargetOps = (count: number, offset: number): void => {
  const transitions: OperationTransition[] = [];
  for (let index = 0; index < count; index += 1) {
    transitions.push({
      kind: 'begin',
      operation: {
        ...ACTION_OWNER,
        operationId: `target-${offset + index}`,
        model: TARGET_MODEL,
        tempIds: [],
        rowIds: [TARGET_ROW],
        intent: 'patch',
        patchedFields: ['score'],
        patchedValues: { score: offset + index },
        createdAt: 10_000 + offset + index
      }
    });
  }
  getApplyRuntime().commit(createCommitEnvelope([], transitions));
};

describe('pending operation index scale', () => {
  it('pendingForRow remains addressed to its row after 3000 foreign operations', () => {
    setupSpecRuntime();
    seedTargetOps(5, 0);
    const expected = ['target-0', 'target-1', 'target-2', 'target-3', 'target-4'];
    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW).map(operation => operation.operationId)).toEqual(expected);
    seedForeignOps(3000);

    // The named operations of THIS row, in creation order, are still the answer among 3000 others.
    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW).map(operation => operation.operationId)).toEqual(expected);
  });

  it('pendingForRow is true only for the operation rows, and flips false after commit/discard', () => {
    setupSpecRuntime();
    const model = defineModelRuntime({ id: 'SpecPendingIndexRow', name: 'SpecPendingIndexRow', fields: { text: f.str() } });
    model.insert({ id: 'row-a', text: 'a' });
    model.insert({ id: 'row-b', text: 'b' });
    const operations = getOperationState();

    operations.begin({ ...ACTION_OWNER, operationId: 'op-commit', model: 'SpecPendingIndexRow', tempIds: [], rowIds: ['row-a'], intent: 'patch', patchedFields: ['text'], patchedValues: { text: 'during' }, createdAt: 1 });
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-a').length).toBe(1);
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-b').length).toBe(0);

    operations.close('op-commit', 'committed');
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-a').length).toBe(0);

    operations.begin({ ...ACTION_OWNER, operationId: 'op-discard', model: 'SpecPendingIndexRow', tempIds: [], rowIds: ['row-b'], intent: 'patch', patchedFields: ['text'], patchedValues: { text: 'during' }, createdAt: 2 });
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-b').length).toBe(1);
    operations.close('op-discard', 'rolledback');
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-b').length).toBe(0);
  });

  it('unsyncedChanges merges patches in the order the operations were created', () => {
    setupSpecRuntime();
    const model = defineModelRuntime({
      id: 'SpecPendingIndexMergeOrder',
      name: 'SpecPendingIndexMergeOrder',
      fields: { a: f.num(), b: f.num(), shared: f.str() }
    });
    const reader = renderCounted(() => model.use.unsyncedChanges(TARGET_ROW));
    act(() => {
      getApplyRuntime().commit(
        createCommitEnvelope([], [
          { kind: 'begin', operation: { ...ACTION_OWNER, operationId: 'op-a', model: 'SpecPendingIndexMergeOrder', tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', patchedFields: ['a', 'shared'], patchedValues: { a: 1, shared: 'from-a' }, createdAt: 1 } },
          { kind: 'begin', operation: { ...ACTION_OWNER, operationId: 'op-noise', model: 'SpecPendingIndexForeign', tempIds: [], rowIds: ['foreign-row-noise'], intent: 'patch', patchedFields: ['x'], patchedValues: { x: 0 }, createdAt: 1 } },
          { kind: 'close', operationId: 'op-noise', status: 'committed' },
          { kind: 'begin', operation: { ...ACTION_OWNER, operationId: 'op-b', model: 'SpecPendingIndexMergeOrder', tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', patchedFields: ['b', 'shared'], patchedValues: { b: 2, shared: 'from-b' }, createdAt: 2 } }
        ])
      );
    });

    expect(reader.result()).toEqual({ a: 1, shared: 'from-b', b: 2 });
    reader.unmount();
  });

  it('failedFor through the index matches the reference full-array scan', () => {
    setupSpecRuntime();
    const operations = getOperationState();
    operations.begin({ ...ACTION_OWNER, operationId: 'op-fail-1', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 1 });
    operations.close('op-fail-1', 'failed');
    operations.begin({ ...ACTION_OWNER, operationId: 'op-fail-2', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 2 });
    operations.close('op-fail-2', 'failed');
    seedForeignOps(50);

    const reference = (() => {
      let latest: OperationRecord | undefined;
      // Reference computed independently of the index, over every operation begun in this test.
      const all = [operations.get('op-fail-1')!, operations.get('op-fail-2')!];
      for (const operation of all) {
        if (operation.status !== 'failed' || operation.model !== TARGET_MODEL || !operation.rowIds.includes(TARGET_ROW)) continue;
        if (!latest || operation.createdAt >= latest.createdAt) latest = operation;
      }
      return latest;
    })();

    expect(operations.failedFor(TARGET_MODEL, TARGET_ROW)?.operationId).toBe(reference?.operationId);
    expect(operations.failedFor(TARGET_MODEL, TARGET_ROW)?.operationId).toBe('op-fail-2');
    expect(operations.failedForRow(TARGET_MODEL, TARGET_ROW).map(operation => operation.operationId).sort()).toEqual(['op-fail-1', 'op-fail-2']);
  });

  it('resetRuntime clears the row index; new operations index cleanly afterward', () => {
    setupSpecRuntime();
    const operations = getOperationState();
    operations.begin({ ...ACTION_OWNER, operationId: 'op-before-reset', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 1 });
    expect(operations.pendingForRow(TARGET_MODEL, TARGET_ROW).length).toBe(1);

    resetRuntime();

    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW).length).toBe(0);

    getOperationState().begin({ ...ACTION_OWNER, operationId: 'op-after-reset', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 2 });
    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW).length).toBe(1);
    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW)[0]!.operationId).toBe('op-after-reset');
  });
});
