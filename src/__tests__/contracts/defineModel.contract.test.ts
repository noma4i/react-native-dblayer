import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineIngest } from '../../dsl/defineIngest';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createContractScenario } from '../helpers/contractScenario';
import { createMemoryStorage } from '../helpers/memoryStorage';

/*
 * C1: Models defined before configuration lazily hydrate when their runtime is configured.
 * C2: Snapshot and event writes never resurrect tombstoned rows, while replace writes may.
 * C3: Guards reject invalid snapshot, scope, and event rows without corrupting valid rows.
 * C4: Normalization and merge gates preserve the model's configured data contract.
 * C5: Declarative by-membership re-parents rows between scope handles in one event plan.
 * C6: Bounded reads apply limit after the requested sort order.
 * C7-C8: Named scopes isolate same-shaped values and delete legacy unnamespaced ledgers.
 * C9: Replace plans preserve every captured scope membership and server order.
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

  it('C2: snapshot upserts to a tombstoned id are dropped while event and replace upserts apply', () => {
    createContractScenario();
    const Model = defineModel({ id: 'TombstoneContract', name: 'TombstoneContract', fields: { title: f.str() }, scopes: { all: scope({}) } });
    Model.insertStored({ id: 'row', title: 'first' });
    Model.destroy('row');

    Model.__applyRows?.([{ id: 'row', title: 'stale' }]);
    Model.scopes.all.__apply?.({}, [{ id: 'row', title: 'stale' }], 'complete');
    expect(Model.get('row')).toBeUndefined();
    expect(Model.scopes.all.read({})).toEqual([]);

    defineIngest(Model, { updated: payload => ({ upsert: payload }) }).apply('updated', { id: 'row', title: 'event' });
    expect(Model.get('row')).toEqual({ id: 'row', title: 'event' });

    Model.replaceRaw('row', { id: 'row', title: 'replacement' });
    expect(Model.get('row')).toEqual({ id: 'row', title: 'replacement' });
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

  it('C6: getWhere and use.where apply limit after orderBy', () => {
    createContractScenario();
    const Model = defineModel({ id: 'LimitContract', name: 'LimitContract', fields: { rank: f.num() } });
    Model.insertStored({ id: 'one', rank: 1 });
    Model.insertStored({ id: 'three', rank: 3 });
    Model.insertStored({ id: 'two', rank: 2 });
    let rows: Array<{ id: string; rank: number }> = [];
    const Harness = () => {
      rows = Model.use.where({}, { orderBy: { field: 'rank', direction: 'desc' }, limit: 2 });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(Harness));
    });

    expect(Model.getWhere({}, { orderBy: { field: 'rank', direction: 'desc' }, limit: 2 }).map(row => row.id)).toEqual(['three', 'two']);
    expect(rows.map(row => row.id)).toEqual(['three', 'two']);
    act(() => {
      renderer.unmount();
    });
  });

  it('C7: named scopes isolate same-shaped values during complete reconciliation', () => {
    createContractScenario();
    const Model = defineModel({ id: 'ScopeNamespaceContract', name: 'ScopeNamespaceContract', fields: { title: f.str() }, scopes: { first: scope({}), second: scope({}) } });

    Model.scopes.first.__apply?.({}, [{ id: 'first', title: 'first' }], 'complete');
    Model.scopes.second.__apply?.({}, [{ id: 'second', title: 'second' }], 'complete');
    Model.scopes.first.__apply?.({}, [{ id: 'replacement', title: 'replacement' }], 'complete');

    expect(Model.scopes.first.read({}).map(row => row.id)).toEqual(['replacement']);
    expect(Model.scopes.second.read({}).map(row => row.id)).toEqual(['second']);
  });

  it('C8: hydration deletes a legacy unnamespaced scope ledger', () => {
    const scenario = createMemoryStorage([
      ['dbl:scope:LegacyScopeKeyContract:__root__', JSON.stringify({ generation: 1, coverage: 'complete', entries: [{ id: 'legacy', order: 0, seq: 1 }] })]
    ]);
    createContractScenario({ storage: scenario });
    const Model = defineModel({ id: 'LegacyScopeKeyContract', name: 'LegacyScopeKeyContract', fields: { title: f.str() }, scopes: { feed: scope({}) } });

    expect(Model.scopes.feed.read({})).toEqual([]);
    expect(scenario.values.has('dbl:scope:LegacyScopeKeyContract:__root__')).toBe(false);
  });

  it('C9: replaceRaw preserves server-order memberships for by and non-by scopes', () => {
    createContractScenario();
    const Model = defineModel({
      id: 'ReplaceScopeMembershipContract',
      name: 'ReplaceScopeMembershipContract',
      fields: { title: f.str(), chatId: f.id() },
      scopes: { thread: scope({ by: { chatId: 'chatId' }, sort: 'server-order' }), feed: scope({ sort: 'server-order' }) }
    });
    const rows = [{ id: 'first', title: 'first', chatId: 'chat' }, { id: 'second', title: 'second', chatId: 'chat' }];
    Model.scopes.thread.__apply?.({ chatId: 'chat' }, rows, 'complete');
    Model.scopes.feed.__apply?.({}, rows, 'complete');

    Model.replaceRaw('first', { id: 'server', title: 'server', chatId: 'chat' });

    expect(Model.scopes.thread.read({ chatId: 'chat' }).map(row => row.id)).toEqual(['server', 'second']);
    expect(Model.scopes.feed.read({}).map(row => row.id)).toEqual(['server', 'second']);

    Model.replaceRaw('server', { id: 'server', title: 'refreshed', chatId: 'chat' });

    expect(Model.scopes.thread.read({ chatId: 'chat' }).map(row => row.id)).toEqual(['server', 'second']);
    expect(Model.scopes.feed.read({}).map(row => row.id)).toEqual(['server', 'second']);
  });
});
