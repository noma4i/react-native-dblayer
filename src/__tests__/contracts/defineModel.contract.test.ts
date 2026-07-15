import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createContractScenario } from '../helpers/contractScenario';
import { createMemoryStorage } from '../helpers/memoryStorage';

/*
 * C1: Models defined before configuration lazily hydrate when their runtime is configured.
 * C2: Snapshot writes never resurrect tombstoned rows, while explicit events may recreate them.
 * C3: Guards reject invalid snapshot, scope, and event rows without corrupting valid rows.
 * C4: Normalization and merge gates preserve the model's configured data contract.
 * C5: Declarative by-membership re-parents rows between scope handles in one event plan.
 */
describe('defineModel contracts', () => {
  it('C1: a model defined before configuration hydrates persisted rows after configuration', () => {
    const Model = defineModel({ id: 'LazyContract', name: 'LazyContract', fields: { title: f.str() } });
    const scenario = createMemoryStorage([['dbl:rows:LazyContract', JSON.stringify([{ id: 'seed', title: 'hydrated' }])]]);
    createContractScenario({ storage: scenario });

    expect(Model.get('seed')).toEqual({ id: 'seed', title: 'hydrated' });
    Model.insertStored({ id: 'live', title: 'written' });
    expect(Model.get('live')).toEqual({ id: 'live', title: 'written' });
  });

  it('C2: snapshot upsert to a tombstoned id is dropped while an explicit event recreates it', () => {
    createContractScenario();
    const Model = defineModel({ id: 'TombstoneContract', name: 'TombstoneContract', fields: { title: f.str() }, scopes: { all: scope({}) } });
    Model.insertStored({ id: 'row', title: 'first' });
    Model.destroy('row');

    Model.__applyRows?.([{ id: 'row', title: 'stale' }]);
    Model.scopes.all.__apply?.({}, [{ id: 'row', title: 'stale' }], 'complete');
    expect(Model.get('row')).toBeUndefined();
    expect(Model.scopes.all.read({})).toEqual([]);

    Model.insertStored({ id: 'row', title: 'event' });
    expect(Model.get('row')).toEqual({ id: 'row', title: 'event' });
  });

  it('C3: guard-rejected rows are dropped while valid snapshot rows continue through the plan', () => {
    const errors = jest.fn();
    createContractScenario({ logger: { debug: jest.fn(), error: errors } });
    const Model = defineModel({ id: 'GuardContract', name: 'GuardContract', fields: { title: f.str() }, guard: input => (input as { ok?: boolean }).ok === true, scopes: { all: scope({}) } });

    expect(() => Model.__applyRows?.([{ id: 'good', ok: true, title: 'kept' }, { id: 'bad', ok: false, title: 'dropped' }])).not.toThrow();
    expect(Model.get('good')).toBeDefined();
    expect(Model.get('bad')).toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });

  it('C3: an id-less scope row and a rejected event leave membership and state clean', () => {
    createContractScenario();
    const Model = defineModel({ id: 'GuardMembershipContract', name: 'GuardMembershipContract', fields: { title: f.str() }, guard: input => (input as { ok?: boolean }).ok === true, scopes: { all: scope({}) } });

    Model.scopes.all.__apply?.({}, [{ id: 'ok', ok: true, title: 'kept' }, { ok: true, title: 'missing-id' } as never], 'complete');
    Model.insertStored({ id: 'bad', ok: false, title: 'dropped' } as never);

    expect(Model.scopes.all.read({}).map(row => row.id)).toEqual(['ok']);
    expect(Model.get('bad')).toBeUndefined();
  });

  it('C4: normalize builds fields from raw input and merge.shouldOverwrite can reject a snapshot', () => {
    createContractScenario();
    const Model = defineModel({
      id: 'MergeContract',
      name: 'MergeContract',
      fields: { title: f.str(), version: f.num() },
      merge: { shouldOverwrite: (existing, incoming) => Number((incoming as { version?: number }).version) >= Number((existing as { version?: number }).version) }
    });
    Model.insertStored({ id: 'row', title: 'current', version: 2 });

    expect(Model.normalize({ id: 'raw', title: 'normalized', version: 1 })).toEqual({ id: 'raw', title: 'normalized', version: 1 });
    Model.__applyRows?.([{ id: 'row', title: 'stale', version: 1 }]);
    expect(Model.get('row')).toEqual({ id: 'row', title: 'current', version: 2 });
  });

  it('C5: an event patch re-parents declarative by-membership between scope handles', () => {
    createContractScenario();
    const Model = defineModel({ id: 'MembershipReparentContract', name: 'MembershipReparentContract', fields: { chatId: f.id() }, scopes: { thread: scope({ by: { chatId: 'chatId' } }) } });
    Model.insertStored({ id: 'row', chatId: 'one' });

    Model.patch('row', { chatId: 'two' });

    expect(Model.scopes.thread.read({ chatId: 'one' })).toEqual([]);
    expect(Model.scopes.thread.read({ chatId: 'two' }).map(row => row.id)).toEqual(['row']);
  });
});
