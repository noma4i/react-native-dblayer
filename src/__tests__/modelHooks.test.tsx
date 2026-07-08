import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createCollectionBinding, devClearAllDataAndState } from '../index';
import { createTodoModel, installMemoryStorage } from './helpers/testRuntime';

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
      await flush();
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    }
  };
};

/** Render harness that supports re-rendering the SAME mounted component with a new prop. */
const renderHookWithProps = <TProps, T>(read: (props: TProps) => T, initialProps: TProps) => {
  let current!: T;
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = ({ props }: { props: TProps }) => {
    current = read(props);
    return null;
  };

  act(() => {
    renderer = TestRenderer.create(<Harness props={initialProps} />);
  });

  return {
    get current() {
      return current;
    },
    rerender(props: TProps) {
      act(() => {
        renderer.update(<Harness props={props} />);
      });
    },
    async flush() {
      await flush();
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    }
  };
};

describe('collection model reactive hooks', () => {
  afterEach(async () => {
    await flush();
    devClearAllDataAndState();
  });

  it('updates find, all, where, byIds, and count subscriptions after collection writes', async () => {
    installMemoryStorage();
    const model = createTodoModel();

    const found = renderHook(() => model.find('1'));
    const all = renderHook(() => model.all());
    const filtered = renderHook(() => model.where({ listId: 'a' }));
    const byIds = renderHook(() => model.byIds(['1', '2']));
    const count = renderHook(() => model.count({ listId: 'a' }));

    expect(found.current).toBeUndefined();
    expect(all.current).toEqual([]);
    expect(filtered.current).toEqual([]);
    expect(byIds.current).toEqual([]);
    expect(count.current).toBe(0);

    act(() => {
      model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
      model.insertStored({ id: '2', title: 'Two', listId: 'b', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    });

    await found.flush();

    expect(found.current?.title).toBe('One');
    expect(all.current.map(item => item.id)).toEqual(['1', '2']);
    expect(filtered.current.map(item => item.id)).toEqual(['1']);
    expect(byIds.current.map(item => item.id).sort()).toEqual(['1', '2']);
    expect(count.current).toBe(1);

    act(() => {
      model.patch('2', { listId: 'a', updatedAt: '2026-01-02T00:00:00.000Z' });
    });

    await found.flush();

    expect(filtered.current.map(item => item.id).sort()).toEqual(['1', '2']);
    expect(count.current).toBe(2);

    act(() => {
      model.destroy('1');
    });

    await found.flush();

    expect(found.current).toBeUndefined();
    expect(all.current.map(item => item.id)).toEqual(['2']);
    expect(filtered.current.map(item => item.id)).toEqual(['2']);
    expect(byIds.current.map(item => item.id)).toEqual(['2']);
    expect(count.current).toBe(1);

    found.unmount();
    all.unmount();
    filtered.unmount();
    byIds.unmount();
    count.unmount();
    await flush();
  });

  it('keeps model.count hook order stable while its filter flips null -> object -> null across renders', () => {
    installMemoryStorage();
    const model = createTodoModel();
    model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });

    const hook = renderHookWithProps<{ listId: string } | null, number>(filter => model.count(filter as never), null);
    expect(hook.current).toBe(0);

    // Each rerender keeps the SAME mounted component instance; a hook-order violation here would throw
    // inside `act` ("Rendered more/fewer hooks than during the previous render").
    hook.rerender({ listId: 'a' });
    expect(hook.current).toBe(1);

    hook.rerender(null);
    expect(hook.current).toBe(0);

    hook.rerender({ listId: 'a' });
    expect(hook.current).toBe(1);

    hook.unmount();
  });

  it('keeps collection-binding count hook order stable while its filter flips null -> object -> null across renders', () => {
    installMemoryStorage();
    const model = createTodoModel();
    model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    const binding = createCollectionBinding(model, { scopeMap: { listId: 'listId' } });

    const hook = renderHookWithProps<{ listId: string } | null, number>(filter => binding.count(filter), null);
    expect(hook.current).toBe(0);

    hook.rerender({ listId: 'a' });
    expect(hook.current).toBe(1);

    hook.rerender(null);
    expect(hook.current).toBe(0);

    hook.rerender({ listId: 'a' });
    expect(hook.current).toBe(1);

    hook.unmount();
  });
});
