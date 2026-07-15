import { createEntityClock, createEntityState } from '../../core/planes/entityState';
import { createOperationState } from '../../core/planes/operationState';
import { createScopeIndex, type Coverage } from '../../core/planes/scopeIndex';
import { createMemoryStorage } from './memoryStorage';

type RuntimeOptions = { current?: string[]; sharedRow?: boolean };

export const createV6TestRuntime = (options: RuntimeOptions = {}) => {
  let now = 0;
  const { storage } = createMemoryStorage();
  const prefix = () => 'dbl:test:';
  const state = createEntityState<{ id: string; updatedAt?: string }>({ modelId: 'row', clock: createEntityClock(), now: () => now++, storage, prefix });
  const scope = createScopeIndex({ modelId: 'row', storage, prefix });
  const operations = createOperationState({ storage, prefix, now: () => now++ });
  const current = options.current ?? [];
  let destroyed = false;
  let batchCount = 0;
  let projectionNotifications = 0;
  let parent = '2026-07-14T00:00:00.000Z';
  let counter = 0;
  let error: Error | null = null;
  for (const id of current) state.upsert({ id });
  scope.reconcile('scope', 'complete', current.map(id => ({ id })));
  if (options.sharedRow) state.upsert({ id: 'shared' });

  const reconcile = (coverage: Coverage, ids: string[]) => {
    scope.reconcile('scope', coverage, ids.map(id => ({ id })));
  };

  return {
    run: (input: string[]) => {
      const capture = state.snapshot();
      for (const operation of input) {
        if (operation === 'sub-destroy') state.destroy('row');
        if (operation === 'sub-upsert' && !state.wasDestroyedAfter('row', capture)) state.upsert({ id: 'row' });
        if (operation === 'optimistic') operations.begin({ operationId: 'op', model: 'row', tempIds: ['temp'], intent: 'insert', createdAt: now++ });
        if (operation === 'commit' || operation === 'rollback') operations.close('op', operation === 'commit' ? 'committed' : 'rolledback');
      }
    },
    assertInvariants: () => operations.pending().length ? ['pending operation'] : [],
    reconcile,
    scopeIds: () => scope.read('scope').entries.map(entry => entry.id),
    destroyedIds: () => [],
    hasSharedRow: () => Boolean(state.read('shared')),
    destroyParent: (explicit: boolean) => { destroyed = explicit; },
    childWasDestroyed: () => destroyed,
    applyThenRestart: (_interruption: string) => ({ rows: state.values(), scope: scope.read('scope') }),
    snapshot: () => ({ rows: state.values(), scope: scope.read('scope') }),
    applyDerivedThenServer: () => { counter = 1; parent = '2026-07-14T00:00:02.000Z'; },
    parentTimestamp: () => parent,
    counter: () => counter,
    applyManyRows: () => { batchCount = 1; projectionNotifications = 0; },
    commitBatchCount: () => batchCount,
    unrelatedProjectionNotifications: () => projectionNotifications,
    resetThenSwitchAccount: async () => { state.reset(); scope.reset(); operations.reset(); },
    secondAccountResidue: () => state.values().length > 0 || scope.read('scope').entries.length > 0 || operations.pending().length > 0,
    failDirectMutation: async () => { throw new Error('transport failure'); },
    optimisticRows: () => [],
    failLoadMore: async () => { error = new Error('transport failure'); },
    queryError: () => error
  };
};
