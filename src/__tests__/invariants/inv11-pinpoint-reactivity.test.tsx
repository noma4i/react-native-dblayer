import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { f } from '../../schema/f';
import { configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import type { StoragePlane } from '../../core/planes/storagePlane';

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
});
