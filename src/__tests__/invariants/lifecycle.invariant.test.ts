import { belongsTo, collectGarbage, defineModel, f, scope } from '../../index';
import { flushPersistence, getOperationState } from '../../dsl/configure';
import { defineMutation } from '../../dsl/defineMutation';
import type { DbGraphQLDocument } from '../../types';
import { createContractScenario } from '../helpers/contractScenario';
import { storageKeyCount } from './session.helpers';

describe('lifecycle invariants', () => {
  it('L-snapshot: scope release, retention, and GC return rows and scope keys to baseline', () => {
    const fixture = createContractScenario();
    const Model = defineModel({ id: 'LifecycleSnapshot', name: 'LifecycleSnapshot', fields: { title: f.str() }, scopes: { feed: scope({ sort: 'server-order', retention: { maxRows: 2 } }) } });
    const baseline = { rows: Model.getAll().length, scopes: storageKeyCount(fixture.storage, 'dbl:scope:LifecycleSnapshot:') };
    Model.scopes.feed.__apply?.({}, [{ id: 'one', title: 'one' }, { id: 'two', title: 'two' }, { id: 'three', title: 'three' }], 'complete');
    Model.scopes.feed.__apply?.({}, [], 'complete');
    collectGarbage();

    expect({ rows: Model.getAll().length, scopes: storageKeyCount(fixture.storage, 'dbl:scope:LifecycleSnapshot:') }).toEqual(baseline);
  });

  it('L-event: unscoped ingest-style event rows return to baseline after GC', () => {
    const fixture = createContractScenario();
    const Model = defineModel({ id: 'LifecycleEvent', name: 'LifecycleEvent', fields: { title: f.str() } });
    const baseline = { rows: Model.getAll().length, rowKeys: storageKeyCount(fixture.storage, 'dbl:row:LifecycleEvent:'), scopeKeys: storageKeyCount(fixture.storage, 'dbl:scope:LifecycleEvent:') };
    Model.insertStored({ id: 'event', title: 'ephemeral' });
    collectGarbage();

    expect({ rows: Model.getAll().length, rowKeys: storageKeyCount(fixture.storage, 'dbl:row:LifecycleEvent:'), scopeKeys: storageKeyCount(fixture.storage, 'dbl:scope:LifecycleEvent:') }).toEqual(baseline);
  });

  it('L-optimistic-commit: replace, close, prune, and GC remove temporary operation residue', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
      const fixture = createContractScenario();
      const Model = defineModel({ id: 'LifecycleCommit', name: 'LifecycleCommit', fields: { title: f.str() } });
      Model.insertStored({ id: 'temp', title: 'temporary' });
      getOperationState().begin({ operationId: 'commit', model: 'LifecycleCommit', tempIds: ['temp'], intent: 'insert', idempotencyKey: 'commit', createdAt: Date.now() });
      Model.replaceRaw('temp', { id: 'server', title: 'server' });
      getOperationState().close('commit', 'committed');
      jest.advanceTimersByTime(60 * 60 * 1000 + 1);
      flushPersistence();
      collectGarbage();

      expect(Model.getAll()).toEqual([]);
      expect(getOperationState().pending()).toEqual([]);
      expect(getOperationState().hasCommitted('commit')).toBe(false);
      expect(fixture.storage.keys('dbl:tombstones:LifecycleCommit')).toEqual(['dbl:tombstones:LifecycleCommit']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('L-optimistic-rollback: a rolled-back temporary insert returns to baseline without a tombstone leak', async () => {
    const fixture = createContractScenario({ transport: { mutation: async () => { throw new Error('rollback'); } } });
    const Model = defineModel({ id: 'LifecycleRollback', name: 'LifecycleRollback', fields: { title: f.str() } });
    const baseline = { rows: Model.getAll().length, tombstones: fixture.storage.keys('dbl:tombstones:LifecycleRollback').length };
    const mutation = defineMutation<unknown, { title: string }, { id: string; title: string }, unknown>({
      document: { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>,
      result: 'create',
      optimistic: { model: Model, build: (input, context) => ({ id: context.tempId!, title: input.title }), selectServerNode: () => null }
    });

    await expect(mutation.run({ title: 'temporary' })).rejects.toThrow('rollback');
    flushPersistence();

    expect({ rows: Model.getAll().length, tombstones: fixture.storage.keys('dbl:tombstones:LifecycleRollback').length }).toEqual(baseline);
  });

  it('L-destroy: expired tombstones, rows, scope entries, and counter residue return to baseline', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
      const fixture = createContractScenario();
      const Parent = defineModel({ id: 'LifecycleParent', name: 'LifecycleParent', fields: { count: f.num() } });
      const Child = defineModel({ id: 'LifecycleChild', name: 'LifecycleChild', fields: { parentId: f.id() }, relations: () => ({ parent: belongsTo(Parent, { foreignKey: 'parentId', counterCache: { field: 'count' } }) }), scopes: { all: scope({}) } });
      Parent.insertStored({ id: 'parent', count: 0 });
      Child.scopes.all.__apply?.({}, [{ id: 'child', parentId: 'parent' }], 'complete');
      Child.destroy('child');
      Parent.destroy('parent');
      jest.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
      flushPersistence();
      collectGarbage();

      expect(Parent.get('parent')).toBeUndefined();
      expect(Child.get('child')).toBeUndefined();
      expect(Parent.getAll()).toEqual([]);
      expect(Child.scopes.all.read({})).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
