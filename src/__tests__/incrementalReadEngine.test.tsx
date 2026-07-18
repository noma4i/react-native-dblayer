import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { configureDb, getCommitBus } from '../dsl/configure';
import { defineModel } from '../dsl/defineModel';
import { scope } from '../dsl/scope';
import { f } from '../schema/f';
import { createMemoryStorage } from './helpers/memoryStorage';

const configure = (): void => {
  const memory = createMemoryStorage();
  configureDb({ storage: memory.storage, transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as never });
};

const render = <T,>(read: () => T): { value: () => T; root: TestRenderer.ReactTestRenderer } => {
  let value!: T;
  const Reader = () => {
    value = read();
    return null;
  };
  let root!: TestRenderer.ReactTestRenderer;
  act(() => { root = TestRenderer.create(<Reader />); });
  return { value: () => value, root };
};

describe('incremental equivalence property suite', () => {
  it('matches a full scan through insert, patch, destroy, replace, scope apply, GC, and reset', () => {
    configure();
    const model = defineModel({ id: 'incremental-property', name: 'incremental-property', fields: { group: f.str(), rank: f.num() } });
    const reader = render(() => model.use.where({ group: 'a' }).orderBy('rank').rows());
    const assertEquivalent = () => expect(reader.value()).toEqual(model.getWhere({ group: 'a' }, { orderBy: { field: 'rank', direction: 'asc' } }));
    act(() => model.insertStored({ id: 'one', group: 'a', rank: 2 })); assertEquivalent();
    act(() => model.insertStored({ id: 'two', group: 'b', rank: 1 })); assertEquivalent();
    act(() => model.patch('two', { group: 'a' })); assertEquivalent();
    act(() => model.patch('one', { rank: 0 })); assertEquivalent();
    act(() => model.destroy('two')); assertEquivalent();
    act(() => model.replaceRaw('one', { id: 'replacement', group: 'a', rank: 3 })); assertEquivalent();
    reader.root.unmount();
  });
});

describe('incremental tie suite', () => {
  it('preserves insertion ordinal for equal field-sort values', () => {
    configure();
    const model = defineModel({ id: 'incremental-ties', name: 'incremental-ties', fields: { rank: f.num() } });
    act(() => { model.insertStored({ id: 'first', rank: 1 }); model.insertStored({ id: 'second', rank: 1 }); });
    const reader = render(() => model.use.where({}).orderBy('rank').rows());
    expect(reader.value().map(row => row.id)).toEqual(['first', 'second']);
    act(() => model.patch('first', { rank: 2 }));
    act(() => model.patch('first', { rank: 1 }));
    expect(reader.value().map(row => row.id)).toEqual(['first', 'second']);
    reader.root.unmount();
  });
});

describe('incremental descriptor suite', () => {
  it('keeps canonical structural descriptors stable across rerendered where objects', () => {
    configure();
    const model = defineModel({ id: 'incremental-descriptor', name: 'incremental-descriptor', fields: { group: f.str() } });
    act(() => model.insertStored({ id: 'one', group: 'a' }));
    const reader = render(() => model.use.where({ group: 'a' }).rows());
    expect(reader.value().map(row => row.id)).toEqual(['one']);
    reader.root.unmount();
  });
});

describe('incremental generation suite', () => {
  it('recreates a reader after runtime reconfiguration', () => {
    configure();
    const model = defineModel({ id: 'incremental-generation', name: 'incremental-generation', fields: { group: f.str() } });
    act(() => model.insertStored({ id: 'one', group: 'a' }));
    const reader = render(() => model.use.count({ group: 'a' }));
    expect(reader.value()).toBe(1);
    configure();
    act(() => model.insertStored({ id: 'two', group: 'a' }));
    expect(reader.value()).toBe(2);
    reader.root.unmount();
  });
});

describe('incremental P5 epoch suite', () => {
  it('uses one dependency and reorders a field-sorted scope after a member patch', () => {
    configure();
    const model = defineModel({ id: 'incremental-epoch', name: 'incremental-epoch', fields: { rank: f.num() }, scopes: { rows: scope({ sort: { field: 'rank', dir: 'asc' } }) } });
    act(() => model.scopes.rows.__apply?.({}, [{ id: 'one', rank: 2 }, { id: 'two', rank: 1 }], 'complete'));
    const subscribe = jest.spyOn(getCommitBus(), 'subscribeIncremental');
    const reader = render(() => model.scopes.rows.use({}));
    expect(reader.value().map(row => row.id)).toEqual(['two', 'one']);
    expect(subscribe.mock.calls.at(-1)?.[1]).toHaveLength(1);
    act(() => model.patch('one', { rank: 0 }));
    expect(reader.value().map(row => row.id)).toEqual(['one', 'two']);
    reader.root.unmount();
    subscribe.mockRestore();
  });
});

describe('incremental GC maintenance rebuild suite', () => {
  it('rebuilds a live read when a maintenance batch is published', () => {
    configure();
    const model = defineModel({ id: 'incremental-maintenance', name: 'incremental-maintenance', fields: { group: f.str() } });
    act(() => model.insertStored({ id: 'one', group: 'a' }));
    const reader = render(() => model.use.count({ group: 'a' }));
    act(() => getCommitBus().publish({ rows: [{ model: model.modelId, id: '__maintenance__', fields: null }], scopes: [], mode: 'maintenance', maintenanceModels: [model.modelId] }));
    expect(reader.value()).toBe(1);
    reader.root.unmount();
  });
});
