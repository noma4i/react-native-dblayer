import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { devClearAllDataAndState, instance, query, useInstance } from '../index';
import { createTodoModel, installMemoryStorage } from './helpers/testRuntime';

const earlier = '2026-01-01T00:00:00.000Z';
const later = '2026-01-02T00:00:00.000Z';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const renderHook = <T,>(read: () => T) => {
  let current!: T;
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = () => {
    current = read();
    return null;
  };

  act(() => {
    renderer = TestRenderer.create(<Harness />);
  });

  return {
    get current() {
      return current;
    },
    async flush() {
      await act(async () => {
        await flush();
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    }
  };
};

const seedTodos = (model: ReturnType<typeof createTodoModel>) => {
  model.insertStored({ id: '1', title: 'One', listId: 'inbox', done: false, updatedAt: earlier });
  model.insertStored({ id: '2', title: 'Two', listId: 'inbox', done: true, updatedAt: earlier });
  model.insertStored({ id: '3', title: 'Three', listId: 'archive', done: false, updatedAt: earlier });
};

describe('active record DSL', () => {
  afterEach(async () => {
    await flush();
    devClearAllDataAndState();
  });

  it('returns snapshot subsets from relation terminals', () => {
    installMemoryStorage();
    const model = createTodoModel();
    seedTodos(model);

    const relation = query(model).where({ listId: 'inbox' });

    expect(relation.getAll().map(row => row.id)).toEqual(['1', '2']);
    expect(relation.getFirst()?.id).toBe('1');
    expect(relation.getCount()).toBe(2);
    expect(relation.getIds()).toEqual(['1', '2']);
  });

  it('patches and deletes every row matched by a relation', () => {
    installMemoryStorage();
    const model = createTodoModel();
    seedTodos(model);

    expect(query(model).where({ listId: 'inbox' }).update({ done: true, updatedAt: later })).toBe(2);
    expect(model.getWhere({ listId: 'inbox' }).every(row => row.done)).toBe(true);

    expect(query(model).where({ done: true }).delete()).toBe(2);
    expect(model.getAll().map(row => row.id)).toEqual(['3']);
  });

  it('reacts to collection writes from relation hook terminals', async () => {
    installMemoryStorage();
    const model = createTodoModel();

    const hook = renderHook(() => {
      const relation = query(model).where({ listId: 'inbox' });
      return {
        rows: relation.all(),
        count: relation.count()
      };
    });

    expect(hook.current.rows).toEqual([]);
    expect(hook.current.count).toBe(0);

    act(() => {
      model.insertStored({ id: '1', title: 'One', listId: 'inbox', done: false, updatedAt: earlier });
      model.insertStored({ id: '2', title: 'Two', listId: 'archive', done: false, updatedAt: earlier });
    });

    await hook.flush();

    expect(hook.current.rows.map(row => row.id)).toEqual(['1']);
    expect(hook.current.count).toBe(1);

    act(() => {
      model.patch('2', { listId: 'inbox', updatedAt: later });
    });

    await hook.flush();

    expect(hook.current.rows.map(row => row.id).sort()).toEqual(['1', '2']);
    expect(hook.current.count).toBe(2);

    hook.unmount();
  });

  it('keeps relation chains immutable', () => {
    installMemoryStorage();
    const model = createTodoModel();
    seedTodos(model);

    const base = query(model).where({ listId: 'inbox' });
    const narrowed = base.where({ done: true });

    expect(base.getIds()).toEqual(['1', '2']);
    expect(narrowed.getIds()).toEqual(['2']);
  });

  it('exposes snapshot instance fields and mutation methods', () => {
    installMemoryStorage();
    const model = createTodoModel();
    seedTodos(model);

    const row = instance(model, '1');

    expect(row?.title).toBe('One');
    expect(row?.update({ title: 'Updated', updatedAt: later })).toBe(true);
    expect(model.get('1')?.title).toBe('Updated');
    expect(row?.delete()).toBe(true);
    expect(model.get('1')).toBeUndefined();
    expect(instance(model, 'missing')).toBeUndefined();
  });

  it('reacts through useInstance and exposes update on the handle', async () => {
    installMemoryStorage();
    const model = createTodoModel();
    seedTodos(model);

    const hook = renderHook(() => useInstance(model, '1'));

    expect(hook.current?.title).toBe('One');

    act(() => {
      hook.current?.update({ title: 'Reactive update', updatedAt: later });
    });

    await hook.flush();

    expect(hook.current?.title).toBe('Reactive update');

    hook.unmount();
  });
});
