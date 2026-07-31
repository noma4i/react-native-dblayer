import { configureDb, defineModelRuntime, f, registerReset, resetRuntime , collectGarbage , createOperationState } from '../../testApi';
import type { OperationStatus } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

describe('pending operation GC roots', () => {
  it('keeps a method-patch row alive while pending and collects it after commit', async () => {
    let resolveMutation!: (value: { data: { pin: { ok: true } } }) => void;
    const transport = createMockTransport({ mutation: async <TData,>() => await new Promise<{ data: TData }>(resolve => (resolveMutation = resolve as typeof resolveMutation)) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModelRuntime({ id: 'LedgerLifecycleGcRows', name: 'LedgerLifecycleGcRows', fields: { pinned: f.bool() } });
    rows.insert({ id: 'row-1', pinned: false });
    const pin = rows.mutation<{ pin: { ok: true } }, Record<string, never>, { id: string; pinned: boolean }, { id: string; pinned: boolean }>('pin', {
      document,
      result: 'pin',
      dedupe: false,
      optimistic: { method: 'patch', model: rows, selectId: () => 'row-1', selectPatch: () => ({ pinned: true }) }
    });

    const pending = pin.run({});

    expect(collectGarbage().evicted.LedgerLifecycleGcRows).toBeUndefined();
    expect(rows.find('row-1')?.pinned).toBe(true);

    resolveMutation({ data: { pin: { ok: true } } });
    await pending;

    expect(collectGarbage().evicted.LedgerLifecycleGcRows).toBe(1);
    expect(rows.find('row-1')).toBeUndefined();
  });
});

describe('resetRuntime failure isolation', () => {
  it('runs every resetter, clears storage, and rethrows resetter failures after the full pass', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    storage.set([{ key: 'dbl:sentinel', value: 'present' }]);
    const calls: string[] = [];
    const unregisterFirst = registerReset(() => {
      calls.push('first');
    });
    const unregisterSecond = registerReset(() => {
      calls.push('second');
      throw new Error('second resetter failed');
    });
    const unregisterThird = registerReset(() => {
      calls.push('third');
    });

    try {
      expect(() => resetRuntime()).toThrow(AggregateError);
      expect(calls).toEqual(['first', 'second', 'third']);
      expect(storage.snapshotKeys()).toEqual([]);
    } finally {
      unregisterFirst();
      unregisterSecond();
      unregisterThird();
    }
  });

  it('runs every resetter and finishes in-memory teardown when storage deletion throws', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    storage.set([{ key: 'dbl:sentinel', value: 'present' }]);
    const set = storage.set;
    let failDeletion = true;
    storage.set = entries => {
      if (failDeletion && entries.some(entry => entry.value === null)) {
        failDeletion = false;
        throw new Error('storage deletion failed');
      }
      set(entries);
    };
    const calls: string[] = [];
    const unregisterFirst = registerReset(() => {
      calls.push('first');
    });
    const unregisterSecond = registerReset(() => {
      calls.push('second');
    });

    try {
      expect(() => resetRuntime()).toThrow(AggregateError);
      expect(calls).toEqual(['first', 'second']);
      expect(storage.snapshotKeys()).toEqual([]);
    } finally {
      unregisterFirst();
      unregisterSecond();
    }
  });
});

const beginOperation = (operationId: string, idempotencyKey: string, once = false) => ({
  operationId,
  model: 'LedgerLifecycleRows',
  tempIds: [],
  rowIds: ['row-1'],
  intent: 'patch' as const,
  idempotencyKey,
  once,
  createdAt: 0
});

const createLedger = () => createOperationState({ storage: createMemoryPlane(), prefix: () => 'ledger:', now: () => 0 });

describe('operation ledger lifecycle invariants', () => {
  it('keeps the first terminal status when close is repeated', () => {
    const ledger = createLedger();
    ledger.begin(beginOperation('operation-1', 'key-1'));

    ledger.close('operation-1', 'committed');
    ledger.close('operation-1', 'rolledback');

    expect(ledger.get('operation-1')?.status).toBe('committed');
  });

  it.each<Exclude<OperationStatus, 'pending'>>(['committed', 'rolledback', 'failed'])('clears pending state after terminal %s', status => {
    const ledger = createLedger();
    const key = `key-${status}`;
    ledger.begin(beginOperation(`operation-${status}`, key));

    ledger.close(`operation-${status}`, status);

    expect(ledger.hasPending(key)).toBe(false);
  });

  it('retains a committed once key until reset', () => {
    const ledger = createLedger();
    ledger.begin(beginOperation('operation-once', 'key-once', true));
    ledger.close('operation-once', 'committed');

    expect(ledger.hasCommitted('key-once')).toBe(true);
    ledger.reset();
    expect(ledger.hasCommitted('key-once')).toBe(false);
  });
});
