import { act } from 'react';
import { createModelStore, defineModelRuntime, f, getOperationState, registerResidency, residencySnapshot, resetRuntime } from '../../testApi';
import { createMemoryPlane, renderCounted, setupSpecRuntime } from '../helpers/harness';

let suffix = 0;
const createRows = () => {
  setupSpecRuntime();
  return defineModelRuntime({
    id: `SpecResidency${(suffix += 1)}`,
    name: `SpecResidency${suffix}`,
    fields: { bucket: f.str(), label: f.str() }
  });
};

/**
 * Housekeeping is only a contract if a leak is visible. Every internal collection that holds an
 * entry on behalf of a live owner drains when that owner goes away, and the gauge is what makes the
 * difference observable: without it, an entry that was never released looks exactly like one that
 * was, and the guard that releases it can be deleted with the whole suite still green.
 */
describe('residency drain', () => {
  it('holds nothing for a reader that unmounted', () => {
    const rows = createRows();
    rows.insertMany([
      { id: 'r-1', bucket: 'a', label: 'one' },
      { id: 'r-2', bucket: 'b', label: 'two' }
    ]);
    const reader = renderCounted(() => rows.use.where({ bucket: 'a' }).rows());
    expect(residencySnapshot().derivedCollections).toBe(1);

    reader.unmount();

    expect(residencySnapshot().derivedCollections).toBe(0);
  });

  it('holds no row bucket for an operation that was taken back', () => {
    createRows();
    expect(residencySnapshot().operationRowBuckets).toBe(0);
    const operation = { operationId: 'op-resident', actionKey: 'SpecResidencyOps:action', actionMode: 'request' as const, model: 'SpecResidencyOps', tempIds: [], rowIds: ['r-op'], intent: 'patch' as const, createdAt: 1 };
    getOperationState().applyTransitions([{ kind: 'begin', operation }]);
    expect(residencySnapshot().operationRowBuckets).toBe(1);

    // Removal leaves the bucket empty, and an empty bucket that stays behind is the leak.
    getOperationState().applyTransitions([{ kind: 'remove', operationId: 'op-resident' }]);

    expect(residencySnapshot().operationRowBuckets).toBe(0);
  });

  it('holds no entry for a model store that was disposed', () => {
    setupSpecRuntime();
    expect(residencySnapshot().modelStores).toBe(0);
    const store = createModelStore<{ id: string }>({
      modelId: `SpecResidencyStore${(suffix += 1)}`,
      now: () => Date.now(),
      storage: createMemoryPlane(),
      prefix: () => 'spec-residency:',
      applyWriteGate: (_previous, incoming) => incoming
    });
    expect(residencySnapshot().modelStores).toBe(1);

    store.dispose();

    expect(residencySnapshot().modelStores).toBe(0);
  });

  it('sums every instance registered under one name and forgets an unregistered gauge', () => {
    const release = registerResidency('specGauge', () => 2);
    const releaseSecond = registerResidency('specGauge', () => 3);
    expect(residencySnapshot().specGauge).toBe(5);

    release();
    releaseSecond();

    expect(residencySnapshot().specGauge).toBeUndefined();
  });

  it('[A1] holds nothing at all once the runtime is reset', () => {
    const rows = createRows();
    rows.insertMany([{ id: 'r-3', bucket: 'a', label: 'three' }]);
    const reader = renderCounted(() => rows.use.where({ bucket: 'a' }).rows());
    reader.unmount();

    act(() => {
      resetRuntime();
    });

    const resident = Object.entries(residencySnapshot()).filter(([, size]) => size > 0);
    expect(resident).toEqual([]);
  });
});
