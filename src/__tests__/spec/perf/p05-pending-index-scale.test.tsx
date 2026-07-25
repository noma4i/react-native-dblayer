import { defineModel, f, resetRuntime } from '../../../index';
import { getOperationState } from '../../../dsl/configure';
import type { OperationRecord } from '../../../core/planes/operationState';
import { setupSpecRuntime } from '../helpers/harness';

const TARGET_MODEL = 'SpecPendingIndexTarget';
const TARGET_ROW = 'target-row';

const seedForeignOps = (count: number): void => {
  const operations = getOperationState();
  for (let index = 0; index < count; index += 1) {
    operations.begin({
      operationId: `foreign-${index}`,
      model: 'SpecPendingIndexForeign',
      tempIds: [],
      rowIds: [`foreign-row-${index}`],
      intent: 'patch',
      patchedFields: ['score'],
      patchedValues: { score: index },
      createdAt: index
    });
  }
};

const seedTargetOps = (count: number, offset: number): void => {
  const operations = getOperationState();
  for (let index = 0; index < count; index += 1) {
    operations.begin({
      operationId: `target-${offset + index}`,
      model: TARGET_MODEL,
      tempIds: [],
      rowIds: [TARGET_ROW],
      intent: 'patch',
      patchedFields: ['score'],
      patchedValues: { score: offset + index },
      createdAt: 10_000 + offset + index
    });
  }
};

const median = (samples: number[]): number => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;

const measure = (fn: () => void, iterations: number, rounds = 7): number =>
  median(
    Array.from({ length: rounds }, () => {
      const started = performance.now();
      for (let index = 0; index < iterations; index += 1) fn();
      return performance.now() - started;
    })
  );

/** Mirrors defineModel's `unsyncedChanges` merge loop, but reads through `pendingForRow`. */
const readUnsyncedChangesViaIndex = (): Record<string, unknown> | undefined => {
  let merged: Record<string, unknown> | undefined;
  for (const operation of getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW)) {
    if (operation.intent !== 'patch' || !operation.patchedValues) continue;
    merged = { ...(merged ?? {}), ...operation.patchedValues };
  }
  return merged;
};

/** The pre-fix shape: a full O(P) scan over every pending operation, same row-match predicate as `pendingForRow`. */
const legacyPendingForRow = (model: string, rowId: string): OperationRecord[] =>
  getOperationState()
    .pending()
    .filter(operation => operation.model === model && (operation.rowIds ?? operation.tempIds).includes(rowId));

const legacyUnsyncedChanges = (): Record<string, unknown> | undefined => {
  let merged: Record<string, unknown> | undefined;
  for (const operation of legacyPendingForRow(TARGET_MODEL, TARGET_ROW)) {
    if (operation.intent !== 'patch' || !operation.patchedValues) continue;
    merged = { ...(merged ?? {}), ...operation.patchedValues };
  }
  return merged;
};

describe('pending operation index scale', () => {
  it('RED (pre-fix shape): a full-array scan breaches the x3 ratio between 5 and 3000 foreign ops', () => {
    setupSpecRuntime();
    seedTargetOps(5, 0);
    const smallLegacy = measure(() => legacyPendingForRow(TARGET_MODEL, TARGET_ROW), 200);
    const smallLegacyMerge = measure(() => legacyUnsyncedChanges(), 200);
    seedForeignOps(3000);
    const largeLegacy = measure(() => legacyPendingForRow(TARGET_MODEL, TARGET_ROW), 200);
    const largeLegacyMerge = measure(() => legacyUnsyncedChanges(), 200);

    const ratio = largeLegacy / Math.max(smallLegacy, 0.01);
    const mergeRatio = largeLegacyMerge / Math.max(smallLegacyMerge, 0.01);
    console.log(`RED legacy pendingForRow ratio=${ratio.toFixed(2)} (${smallLegacy.toFixed(3)}ms -> ${largeLegacy.toFixed(3)}ms)`);
    console.log(`RED legacy unsyncedChanges ratio=${mergeRatio.toFixed(2)} (${smallLegacyMerge.toFixed(3)}ms -> ${largeLegacyMerge.toFixed(3)}ms)`);

    expect(ratio).toBeGreaterThan(3);
    expect(mergeRatio).toBeGreaterThan(3);
  });

  it('GREEN: pendingForRow/unsyncedChanges stay within a x3 ratio between 5 and 3000 foreign ops', () => {
    setupSpecRuntime();
    seedTargetOps(5, 0);
    const smallIndexed = measure(() => getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW), 200);
    const smallIndexedMerge = measure(() => readUnsyncedChangesViaIndex(), 200);
    seedForeignOps(3000);
    const largeIndexed = measure(() => getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW), 200);
    const largeIndexedMerge = measure(() => readUnsyncedChangesViaIndex(), 200);

    const ratio = largeIndexed / Math.max(smallIndexed, 0.01);
    const mergeRatio = largeIndexedMerge / Math.max(smallIndexedMerge, 0.01);
    console.log(`GREEN indexed pendingForRow ratio=${ratio.toFixed(2)} (${smallIndexed.toFixed(3)}ms -> ${largeIndexed.toFixed(3)}ms)`);
    console.log(`GREEN indexed unsyncedChanges ratio=${mergeRatio.toFixed(2)} (${smallIndexedMerge.toFixed(3)}ms -> ${largeIndexedMerge.toFixed(3)}ms)`);

    expect(ratio).toBeLessThanOrEqual(3);
    expect(mergeRatio).toBeLessThanOrEqual(3);
  });

  it('pendingForRow is true only for the operation rows, and flips false after commit/discard', () => {
    setupSpecRuntime();
    const model = defineModel({ id: 'SpecPendingIndexRow', name: 'SpecPendingIndexRow', fields: { text: f.str() } });
    model.insertStored({ id: 'row-a', text: 'a' });
    model.insertStored({ id: 'row-b', text: 'b' });
    const operations = getOperationState();

    operations.begin({ operationId: 'op-commit', model: 'SpecPendingIndexRow', tempIds: [], rowIds: ['row-a'], intent: 'patch', patchedFields: ['text'], patchedValues: { text: 'during' }, createdAt: 1 });
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-a').length).toBe(1);
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-b').length).toBe(0);

    operations.close('op-commit', 'committed');
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-a').length).toBe(0);

    operations.begin({ operationId: 'op-discard', model: 'SpecPendingIndexRow', tempIds: [], rowIds: ['row-b'], intent: 'patch', patchedFields: ['text'], patchedValues: { text: 'during' }, createdAt: 2 });
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-b').length).toBe(1);
    operations.close('op-discard', 'rolledback');
    expect(operations.pendingForRow('SpecPendingIndexRow', 'row-b').length).toBe(0);
  });

  it('unsyncedChanges merges patches in the order the operations were created', () => {
    setupSpecRuntime();
    const operations = getOperationState();
    operations.begin({ operationId: 'op-a', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', patchedFields: ['a', 'shared'], patchedValues: { a: 1, shared: 'from-a' }, createdAt: 1 });
    // An unrelated close on a different row exercises the bucket-remove/bucket-add path without touching this row's order.
    operations.begin({ operationId: 'op-noise', model: 'SpecPendingIndexForeign', tempIds: [], rowIds: ['foreign-row-noise'], intent: 'patch', patchedFields: ['x'], patchedValues: { x: 0 }, createdAt: 1 });
    operations.close('op-noise', 'committed');
    operations.begin({ operationId: 'op-b', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', patchedFields: ['b', 'shared'], patchedValues: { b: 2, shared: 'from-b' }, createdAt: 2 });

    expect(readUnsyncedChangesViaIndex()).toEqual({ a: 1, shared: 'from-b', b: 2 });
  });

  it('failedFor through the index matches the reference full-array scan', () => {
    setupSpecRuntime();
    const operations = getOperationState();
    operations.begin({ operationId: 'op-fail-1', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 1 });
    operations.close('op-fail-1', 'failed');
    operations.begin({ operationId: 'op-fail-2', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 2 });
    operations.close('op-fail-2', 'failed');
    seedForeignOps(50);

    const reference = (() => {
      let latest: OperationRecord | undefined;
      // Reference computed independently of the index, over every operation begun in this test.
      const all = [operations.get('op-fail-1')!, operations.get('op-fail-2')!];
      for (const operation of all) {
        if (operation.status !== 'failed' || operation.model !== TARGET_MODEL || !(operation.rowIds ?? operation.tempIds).includes(TARGET_ROW)) continue;
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
    operations.begin({ operationId: 'op-before-reset', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 1 });
    expect(operations.pendingForRow(TARGET_MODEL, TARGET_ROW).length).toBe(1);

    resetRuntime();

    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW).length).toBe(0);

    getOperationState().begin({ operationId: 'op-after-reset', model: TARGET_MODEL, tempIds: [], rowIds: [TARGET_ROW], intent: 'patch', createdAt: 2 });
    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW).length).toBe(1);
    expect(getOperationState().pendingForRow(TARGET_MODEL, TARGET_ROW)[0]!.operationId).toBe('op-after-reset');
  });
});
