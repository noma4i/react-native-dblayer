import { configureDb, defineModel, f, scope } from '../../../index';
import { getApplyTarget } from '../../../core/apply/applyTargetRegistry';
import { createCommitEnvelope } from '../../../core/apply/commitEnvelope';
import { createJournal } from '../../../core/apply/journal';
import { getApplyRuntime, getCommitBus } from '../../../dsl/configure';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const createModels = () => {
  const first = defineModel({
    id: 'ApplyRecoveryFirst',
    name: 'ApplyRecoveryFirst',
    fields: { label: f.str() },
    scopes: { all: scope({ sort: 'server-order' }) }
  });
  const second = defineModel({
    id: 'ApplyRecoverySecond',
    name: 'ApplyRecoverySecond',
    fields: { label: f.str() },
    scopes: { all: scope({ sort: 'server-order' }) }
  });
  return { first, second };
};

describe('post-WAL apply recovery', () => {
  let storage: ReturnType<typeof createMemoryPlane>;

  beforeEach(() => {
    storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
  });

  it('replays once from a clean row state and publishes only the recovered batch', () => {
    const { first, second } = createModels();
    const target = getApplyTarget(second.modelId);
    const originalPut = target.put;
    let attempts = 0;
    target.put = rows => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient row apply failure');
      return originalPut(rows);
    };
    const published: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => published.push(batch));

    try {
      expect(() =>
        getApplyRuntime().commit(
          createCommitEnvelope([
            { kind: 'upsert', model: first.modelId, rows: [{ id: 'first-row', label: 'first' }] },
            { kind: 'upsert', model: second.modelId, rows: [{ id: 'second-row', label: 'second' }] }
          ])
        )
      ).not.toThrow();

      expect(attempts).toBe(2);
      expect(first.find('first-row')).toMatchObject({ label: 'first' });
      expect(second.find('second-row')).toMatchObject({ label: 'second' });
      expect(published).toHaveLength(1);
    } finally {
      target.put = originalPut;
      unsubscribe();
    }
  });

  it('aborts scope deltas before replay so generation advances once', () => {
    const { first, second } = createModels();
    first.scopes.all.seed({}, [{ id: 'first-seed', label: 'seed' }]);
    second.scopes.all.seed({}, [{ id: 'second-seed', label: 'seed' }]);
    first.insert({ id: 'first-next', label: 'next' });
    second.insert({ id: 'second-next', label: 'next' });
    const firstTarget = getApplyTarget(first.modelId);
    const secondTarget = getApplyTarget(second.modelId);
    const firstScopeKey = firstTarget.readAllScopeKeys()[0]!;
    const secondScopeKey = secondTarget.readAllScopeKeys()[0]!;
    const initialGeneration = firstTarget.readScopeGeneration(firstScopeKey);
    const originalScopeDelta = secondTarget.scopeDelta;
    let attempts = 0;
    secondTarget.scopeDelta = (scopeKey, delta) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient scope apply failure');
      originalScopeDelta(scopeKey, delta);
    };
    const published: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => published.push(batch));

    try {
      expect(() =>
        getApplyRuntime().commit(
          createCommitEnvelope([
            {
              kind: 'scope-delta',
              model: first.modelId,
              scopeKey: firstScopeKey,
              append: [{ id: 'first-next', orderKey: 'z' }],
              detach: []
            },
            {
              kind: 'scope-delta',
              model: second.modelId,
              scopeKey: secondScopeKey,
              append: [{ id: 'second-next', orderKey: 'z' }],
              detach: []
            }
          ])
        )
      ).not.toThrow();

      expect(attempts).toBe(2);
      expect(firstTarget.readScopeGeneration(firstScopeKey)).toBe(initialGeneration + 1);
      expect(firstTarget.readScopeEntries(firstScopeKey).map(entry => entry.id)).toEqual(['first-seed', 'first-next']);
      expect(published).toHaveLength(1);
    } finally {
      secondTarget.scopeDelta = originalScopeDelta;
      unsubscribe();
    }
  });

  it('poisons reads and publishes nothing when clean replay also fails', () => {
    const { first, second } = createModels();
    const target = getApplyTarget(second.modelId);
    const originalPut = target.put;
    target.put = () => {
      throw new Error('permanent apply failure');
    };
    const published: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => published.push(batch));

    try {
      expect(() =>
        getApplyRuntime().commit(
          createCommitEnvelope([
            { kind: 'upsert', model: first.modelId, rows: [{ id: 'first-row', label: 'first' }] },
            { kind: 'upsert', model: second.modelId, rows: [{ id: 'second-row', label: 'second' }] }
          ])
        )
      ).toThrow('permanent apply failure');

      expect(() => first.find('first-row')).toThrow('poisoned');
      expect(published).toHaveLength(0);
    } finally {
      target.put = originalPut;
      unsubscribe();
    }
  });

  it('keeps a failed boot replay pending and closes public reads', () => {
    const { first, second } = createModels();
    const target = getApplyTarget(second.modelId);
    const originalPut = target.put;
    target.put = () => {
      throw new Error('boot replay failure');
    };
    const journal = createJournal(storage, () => 'dbl:');
    storage.set(
      journal.pendingEntry({
        txId: 'boot-replay',
        runtimeEpoch: 1,
        epoch: 1,
        status: 'pending',
        ops: [
          { kind: 'upsert', model: first.modelId, rows: [{ id: 'first-row', label: 'first' }] },
          { kind: 'upsert', model: second.modelId, rows: [{ id: 'second-row', label: 'second' }] }
        ]
      })
    );
    const published: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => published.push(batch));

    try {
      expect(() => getApplyRuntime().replay()).toThrow('boot replay failure');
      expect(() => first.find('first-row')).toThrow('poisoned');
      expect(published).toHaveLength(0);
      expect(journal.pending()).toHaveLength(1);
    } finally {
      target.put = originalPut;
      unsubscribe();
    }
  });

  it('replays every pending record even when txIds collide across process lifetimes', () => {
    const { second } = createModels();
    const journal = createJournal(storage, () => 'dbl:');
    storage.set([
      ...journal.pendingEntry({
        txId: '1:1',
        runtimeEpoch: 1,
        epoch: 1,
        status: 'pending',
        ops: [{ kind: 'upsert', model: second.modelId, rows: [{ id: 'boot-a', label: 'a' }] }]
      }),
      ...journal.pendingEntry({
        txId: '1:1',
        runtimeEpoch: 1,
        epoch: 2,
        status: 'pending',
        ops: [{ kind: 'upsert', model: second.modelId, rows: [{ id: 'boot-b', label: 'b' }] }]
      })
    ]);

    expect(getApplyRuntime().replay()).toBe(2);
    expect(second.find('boot-a')).toMatchObject({ label: 'a' });
    expect(second.find('boot-b')).toMatchObject({ label: 'b' });
  });
});
