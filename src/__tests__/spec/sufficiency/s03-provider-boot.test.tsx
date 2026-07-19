import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as dbl from '../../../index';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

const DbProvider = (
  dbl as unknown as {
    DbProvider: React.ComponentType<{ children: React.ReactNode; bootOptions?: { wipe?: boolean } }>;
  }
).DbProvider;
const document = { kind: 'Document', definitions: [] } as never;
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('provider-owned query runtime', () => {
  // Performance scale guarantee: N/A because provider lifecycle has no scale-dependent input.
  let appStateHandler: ((state: string) => void) | undefined;
  let removeAppStateListener: jest.Mock;

  beforeEach(() => {
    removeAppStateListener = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: removeAppStateListener };
    }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gates children until boot completes and then supports DSL reads', async () => {
    setupSpecRuntime();
    const users = dbl.defineModel({ id: 'SpecProviderBoot', name: 'SpecProviderBoot', fields: { name: dbl.f.str() }, gc: 'exempt' });
    users.insertStored({ id: 'user', name: 'Ready' });
    let renders = 0;
    let value: string | undefined;
    const Child = () => {
      renders += 1;
      value = users.use.row('user')?.name;
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Child)));
    });
    expect(renders).toBe(0);
    await settle();
    expect(renders).toBe(1);
    expect(value).toBe('Ready');
    act(() => root.unmount());
  });

  it('flushes pending persistence on background and stays available on active', async () => {
    const { storage } = setupSpecRuntime();
    const users = dbl.defineModel({ id: 'SpecProviderBackground', name: 'SpecProviderBackground', fields: { name: dbl.f.str() }, gc: 'exempt' });
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement('screen')));
    });
    await settle();
    act(() => users.insertStored({ id: 'user', name: 'Pending' }));
    expect(storage.snapshotKeys().some(key => key.startsWith('dbl:row:SpecProviderBackground:'))).toBe(false);

    act(() => appStateHandler?.('background'));
    expect(storage.snapshotKeys().some(key => key.startsWith('dbl:row:SpecProviderBackground:'))).toBe(true);
    act(() => appStateHandler?.('active'));
    expect(root.toJSON()).toMatchObject({ type: 'screen' });
    act(() => root.unmount());
  });

  it('clears query state so a remount hydrates only the fresh generation', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { rows: [{ id: calls === 1 ? 'old' : 'fresh', name: calls === 1 ? 'Old' : 'Fresh' }] } as TData };
      }
    });
    dbl.configureDb({ storage: createMemoryPlane(), transport } as never);
    const users = dbl.defineModel({ id: 'SpecProviderReset', name: 'SpecProviderReset', fields: { name: dbl.f.str() }, gc: 'exempt' });
    const query = users.query<{ rows: Array<{ id: string; name: string }> }, Record<string, never>, Record<string, never>, { id: string; name: string }>('screen', {
      document,
      key: 'spec-provider-reset',
      select: data => data.rows
    });
    const Reader = () => {
      query.use({});
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(users.get('old')?.name).toBe('Old');
    act(() => root.unmount());
    act(() => dbl.resetRuntime());

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(users.get('old')).toBeUndefined();
    expect(users.get('fresh')?.name).toBe('Fresh');
    act(() => root.unmount());
  });

  it('drops an in-flight response that lands after reset', async () => {
    let resolve!: (value: { data: { value: string } }) => void;
    const transport = createMockTransport({
      query: <TData,>() =>
        new Promise<{ data: TData }>(done => {
          resolve = done as never;
        })
    });
    dbl.configureDb({ storage: createMemoryPlane(), transport } as never);
    const request = dbl.defineFetch<{ value: string }, void, string>({ document, key: 'spec-provider-fence', select: data => data.value });
    const pending = request.fetch(undefined);

    act(() => dbl.resetRuntime());
    resolve({ data: { value: 'stale' } });
    await expect(pending).rejects.toThrow('runtime was reset before it resolved');
  });

  it('resubscribes after reset without delivering stale generation events', () => {
    const handlers: Array<{ next: (data: unknown) => void }> = [];
    const unsubscribes: jest.Mock[] = [];
    const transport = createMockTransport({
      subscribe: (_options, nextHandlers) => {
        handlers.push(nextHandlers);
        const unsubscribe = jest.fn();
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      }
    });
    dbl.configureDb({ storage: createMemoryPlane(), transport } as never);
    const received: string[] = [];
    const runtime = dbl.createDbSubscriptionRuntime([{ key: 'event', query: document, onData: payload => received.push((payload as { value: string }).value) }]);

    runtime.setActive(true);
    act(() => dbl.resetRuntime());
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    runtime.setActive(true);
    expect(handlers).toHaveLength(2);
    handlers[0]?.next({ event: { value: 'stale' } });
    handlers[1]?.next({ event: { value: 'fresh' } });
    expect(received).toEqual(['fresh']);
    runtime.stop();
  });

  it('preserves the child mount and cached request across provider rerenders', async () => {
    setupSpecRuntime();
    let calls = 0;
    let mounts = 0;
    let unmounts = 0;
    const request = dbl.defineFetch<number, void, number>({ key: 'spec-provider-identity', fetcher: async () => ++calls, select: (data: number) => data } as never);
    const Child = () => {
      request.use(undefined);
      React.useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Child)));
    });
    await settle();
    act(() => root.update(React.createElement(DbProvider, null, React.createElement(Child))));
    await settle();

    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(calls).toBe(1);
    act(() => root.unmount());
  });

  it('removes its AppState listener and leaves no timers on unmount', async () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement('screen')));
    });
    await settle();
    act(() => {
      jest.runOnlyPendingTimers();
      root.unmount();
    });

    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
