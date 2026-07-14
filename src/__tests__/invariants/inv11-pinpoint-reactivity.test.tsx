import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { f } from '../../schema/f';
import { configureDb, getApplyRuntime } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { resetRuntime } from '../../core/reset';

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const createModel = (id: string) => {
  configureDb({
    storage: createStorage(),
    transport: {
      query: async () => ({ data: {} }),
      mutation: async () => ({ data: {} })
    } as any
  });
  return defineModel({ id, name: id, fields: { name: f.str(), age: f.num(), group: f.str() } });
};

const renderRead = <T,>(read: () => T) => {
  let value: T;
  let forceRender: (() => void) | null = null;
  const renders = jest.fn();
  const Reader = () => {
    const [, setVersion] = React.useState(0);
    forceRender = () => setVersion(version => version + 1);
    value = read();
    renders();
    return null;
  };
  act(() => { TestRenderer.create(<Reader />); });
  return { value: () => value!, renders, forceRender: () => act(() => forceRender!()) };
};

describe('v6 invariant 11: pinpoint reactivity', () => {
  it('re-renders only the row reader whose row changed', () => {
    const model = createModel('row-pinpoint');
    model.insertStored({ id: '1', name: 'one', age: 1, group: 'a' });
    model.insertStored({ id: '2', name: 'two', age: 2, group: 'a' });
    const first = jest.fn();
    const second = jest.fn();
    const Reader = ({ id, onRender }: { id: string; onRender: () => void }) => {
      model.use.row(id);
      onRender();
      return null;
    };
    act(() => { TestRenderer.create(<><Reader id="1" onRender={first} /><Reader id="2" onRender={second} /></>); });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    act(() => model.patch('1', { name: 'updated' }));
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('notifies a field reader only when its selected field changes', () => {
    const model = createModel('field-pinpoint');
    model.insertStored({ id: '1', name: 'one', age: 1, group: 'a' });
    const read = renderRead(() => model.use.field('1', 'name'));
    expect(read.value()).toBe('one');
    expect(read.renders).toHaveBeenCalledTimes(1);
    act(() => model.patch('1', { age: 2 }));
    expect(read.value()).toBe('one');
    expect(read.renders).toHaveBeenCalledTimes(1);
    act(() => model.patch('1', { name: 'updated' }));
    expect(read.value()).toBe('updated');
    expect(read.renders).toHaveBeenCalledTimes(2);
  });

  it('keeps a where result reference when its members are unchanged', () => {
    const model = createModel('where-pinpoint');
    model.insertStored({ id: '1', name: 'one', age: 1, group: 'a' });
    model.insertStored({ id: '2', name: 'two', age: 2, group: 'b' });
    const read = renderRead(() => model.use.where({ group: 'a' }));
    const before = read.value();
    act(() => model.patch('2', { age: 3 }));
    expect(read.value()).toBe(before);
    expect(read.renders).toHaveBeenCalledTimes(1);
    read.forceRender();
    expect(read.renders).toHaveBeenCalledTimes(2);
    expect(read.value()).toBe(before);
    act(() => model.patch('1', { name: 'updated' }));
    expect(read.value()).not.toBe(before);
  });

  it('reads scopes with field, comparator, and server order sorting', () => {
    configureDb({ storage: createStorage(), transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any });
    const fields = { name: f.str(), age: f.num(), group: f.str() };
    const byField = defineModel({ id: 'scope-field', name: 'scope-field', fields, scopes: { rows: scope({ sort: { field: 'age', dir: 'asc' } }) } });
    const byComparator = defineModel({ id: 'scope-comparator', name: 'scope-comparator', fields, scopes: { rows: scope({ sort: { comparator: (left: any, right: any) => right.age - left.age } }) } });
    const byServerOrder = defineModel({ id: 'scope-server', name: 'scope-server', fields, scopes: { rows: scope({ sort: 'server-order' }) } });
    const rows = [{ id: '1', name: 'one', age: 2, group: 'a' }, { id: '2', name: 'two', age: 1, group: 'a' }, { id: '3', name: 'three', age: 3, group: 'a' }];
    act(() => {
      (byField.scopes as any).rows.__apply({}, rows, 'complete');
      (byComparator.scopes as any).rows.__apply({}, rows, 'complete');
      (byServerOrder.scopes as any).rows.__apply({}, [rows[2], rows[0], rows[1]], 'complete');
    });
    expect((byField.scopes as any).rows.read({}).map((row: any) => row.id)).toEqual(['2', '1', '3']);
    expect((byComparator.scopes as any).rows.read({}).map((row: any) => row.id)).toEqual(['3', '1', '2']);
    expect((byServerOrder.scopes as any).rows.read({}).map((row: any) => row.id)).toEqual(['3', '1', '2']);
  });

  it('applies cross-model operations in one epoch and journal record', () => {
    const storage = createStorage();
    configureDb({ storage, transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any });
    const first = defineModel({ id: 'cross-first', name: 'cross-first', fields: { name: f.str() } });
    const second = defineModel({ id: 'cross-second', name: 'cross-second', fields: { name: f.str() } });
    const runtime = getApplyRuntime();
    act(() => { runtime.apply([{ kind: 'upsert', model: 'cross-first', rows: [{ id: '1', name: 'one' }] }, { kind: 'upsert', model: 'cross-second', rows: [{ id: '2', name: 'two' }] }]); });
    expect(runtime.currentEpoch()).toBe(1);
    expect(storage.keys('dbl:journal:')).toHaveLength(1);
    expect(first.get('1')?.name).toBe('one');
    expect(second.get('2')?.name).toBe('two');
  });

  it('notifies live reads on reset and keeps apply targets live for new writes', async () => {
    const model = createModel('reset-live');
    model.insertStored({ id: '1', name: 'one', age: 1, group: 'a' });
    const read = renderRead(() => model.use.row('1'));
    expect(read.value()?.name).toBe('one');
    await act(async () => { await resetRuntime(); });
    expect(read.value()).toBeUndefined();
    act(() => model.insertStored({ id: '1', name: 'two', age: 2, group: 'a' }));
    expect(read.value()?.name).toBe('two');
  });

  it('grows scope windows by the configured page size', () => {
    configureDb({ storage: createStorage(), defaults: { pageSize: 2 }, transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any });
    const model = defineModel({ id: 'window-live', name: 'window-live', fields: { name: f.str() }, scopes: { rows: scope({ sort: 'server-order' }) } });
    const scopeValue = {};
    act(() => (model.scopes as any).rows.__apply(scopeValue, [{ id: '1', name: 'one' }, { id: '2', name: 'two' }, { id: '3', name: 'three' }, { id: '4', name: 'four' }, { id: '5', name: 'five' }], 'complete'));
    const read = renderRead(() => (model.scopes as any).rows.useWindow(scopeValue, { pageSize: 2 }));
    expect(read.value().rows).toHaveLength(2);
    expect(read.value().totalCount).toBe(5);
    expect(read.value().hasMore).toBe(true);
    act(() => read.value().loadMore());
    expect(read.value().rows).toHaveLength(4);
    act(() => read.value().loadMore());
    expect(read.value().rows).toHaveLength(5);
    expect(read.value().hasMore).toBe(false);
  });
});
