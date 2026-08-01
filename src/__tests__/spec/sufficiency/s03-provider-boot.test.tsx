import React, { act } from 'react';
import { AppState } from 'react-native';
import TestRenderer from 'react-test-renderer';
import * as dbl from '../../testApi';
import { registerBootValidation , DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../testApi';
import { compositeStorageKey, createMemoryPlane, createMockTransport, setupSpecRuntime, settle } from '../helpers/harness';

const DbProvider = (
  dbl as unknown as {
    DbProvider: React.ComponentType<{ children: React.ReactNode }>;
  }
).DbProvider;
const document = { kind: 'Document', definitions: [] } as never;
/** Minimal boundary to observe a render-thrown boot error the way a consumer's Sentry/ErrorBoundary would. */
class BootErrorBoundary extends React.Component<{ children?: React.ReactNode; onError: (error: unknown) => void }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

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
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('gates children until boot completes and then supports DSL reads', async () => {
    setupSpecRuntime();
    const users = dbl.defineModelRuntime({ id: 'SpecProviderBoot', name: 'SpecProviderBoot', fields: { name: dbl.f.str() } });
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });
    users.insert({ id: 'user', name: 'Ready' });
    let renders = 0;
    let value: string | undefined;
    const Child = () => {
      renders += 1;
      value = users.use.find('user')?.name;
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Child)));
    });
    expect(renders).toBe(0);
    await settle(2);
    expect(renders).toBe(1);
    expect(value).toBe('Ready');
    act(() => root.unmount());
  });

  it('does not attach AppState maintenance before boot completes', async () => {
    setupSpecRuntime();
    let resolveBoot!: () => void;
    const boot = jest.spyOn(dbl.lifecycleModule, 'bootDb').mockReturnValue(
      new Promise(resolve => {
        resolveBoot = () => resolve({ replayed: 0, maintenance: [], reset: false });
      })
    );
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement('screen')));
    });

    expect(AppState.addEventListener).not.toHaveBeenCalled();
    await act(async () => {
      resolveBoot();
      await Promise.resolve();
    });
    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    boot.mockRestore();
  });

  it('restarts a stale boot instead of surfacing its rejection after reset', async () => {
    setupSpecRuntime();
    let rejectFirstBoot!: (error: Error) => void;
    const firstBoot = new Promise<never>((_resolve, reject) => {
      rejectFirstBoot = reject;
    });
    const boot = jest
      .spyOn(dbl.lifecycleModule, 'bootDb')
      .mockReturnValueOnce(firstBoot)
      .mockResolvedValueOnce({ replayed: 0, maintenance: [], reset: false });
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement('screen')));
    });
    act(() => dbl.resetRuntime());
    await act(async () => {
      rejectFirstBoot(new Error('stale boot'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(boot).toHaveBeenCalledTimes(2);
    expect(root.toJSON()).toMatchObject({ type: 'screen' });
    act(() => root.unmount());
    boot.mockRestore();
  });

  it('restarts a stale successful boot after reset', async () => {
    setupSpecRuntime();
    let resolveFirstBoot!: () => void;
    const firstBoot = new Promise<Awaited<ReturnType<typeof dbl.bootDb>>>(resolve => {
      resolveFirstBoot = () => resolve({ replayed: 0, maintenance: [], reset: false });
    });
    const boot = jest
      .spyOn(dbl.lifecycleModule, 'bootDb')
      .mockReturnValueOnce(firstBoot)
      .mockResolvedValueOnce({ replayed: 0, maintenance: [], reset: false });
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement('screen')));
    });
    act(() => dbl.resetRuntime());
    await act(async () => {
      resolveFirstBoot();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(boot).toHaveBeenCalledTimes(2);
    expect(root.toJSON()).toMatchObject({ type: 'screen' });
    act(() => root.unmount());
    boot.mockRestore();
  });

  it('throws the boot rejection in render instead of gating children forever', async () => {
    setupSpecRuntime();
    registerBootValidation('s03-probe', () => {
      throw new Error('boot validation exploded');
    });
    let renders = 0;
    const Child = () => {
      renders += 1;
      return null;
    };
    let caught: unknown;
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(
        React.createElement(
          BootErrorBoundary,
          {
            onError: (error: unknown) => {
              caught = error;
            }
          },
          React.createElement(DbProvider, null, React.createElement(Child))
        )
      );
    });
    expect(renders).toBe(0);
    await settle(2);

    expect(renders).toBe(0);
    expect((caught as Error)?.message).toBe('boot validation exploded');
    act(() => root.unmount());
    /** Definition registries survive reset; redefinition under the same key is the canonical cleanup. */
    registerBootValidation('s03-probe', () => {});
  });

  it('flushes pending persistence on background and drains readers after background or inactive', async () => {
    const { storage } = setupSpecRuntime();
    const users = dbl.defineModelRuntime({ id: 'SpecProviderBackground', name: 'SpecProviderBackground', fields: { name: dbl.f.str() } });
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement('screen')));
    });
    await settle(2);
    const refetch = jest.fn(async () => undefined);
    const releaseReader = dbl.registerActiveFetchReaders({
      queryKey: ['provider-app-state'],
      markResumeStale: () => true,
      refetch
    });
    act(() => users.insert({ id: 'user', name: 'Pending' }));
    expect(storage.snapshotKeys().some(key => key.startsWith(compositeStorageKey('dbl:', 'row', 'SpecProviderBackground')))).toBe(false);

    act(() => appStateHandler?.('background'));
    expect(storage.snapshotKeys().some(key => key.startsWith(compositeStorageKey('dbl:', 'row', 'SpecProviderBackground')))).toBe(true);
    act(() => appStateHandler?.('active'));
    await settle(2);
    expect(root.toJSON()).toMatchObject({ type: 'screen' });
    act(() => appStateHandler?.('inactive'));
    act(() => appStateHandler?.('active'));
    await settle(2);
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(root.toJSON()).toMatchObject({ type: 'screen' });
    releaseReader();
    act(() => root.unmount());
  });

  it('rejects boot when the runtime generation changes during synchronous replay', async () => {
    const storage = createMemoryPlane();
    const keys = storage.keys;
    let advanced = false;
    storage.keys = prefix => {
      const result = keys(prefix);
      if (!advanced && prefix.includes('row')) {
        advanced = true;
        dbl.advanceRuntimeGeneration();
      }
      return result;
    };
    dbl.configureDb({ storage, transport: createMockTransport() } as never);

    await expect(dbl.bootDb()).rejects.toThrow('runtime generation changed during boot');
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
    const users = dbl.defineModelRuntime({ id: 'SpecProviderReset', name: 'SpecProviderReset', fields: { name: dbl.f.str() } });
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
    await settle(2);
    expect(users.find('old')?.name).toBe('Old');
    act(() => root.unmount());
    act(() => dbl.resetRuntime());

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle(2);
    expect(users.find('old')).toBeUndefined();
    expect(users.find('fresh')?.name).toBe('Fresh');
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
    await settle(2);
    act(() => root.update(React.createElement(DbProvider, null, React.createElement(Child))));
    await settle(2);

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
    await settle(2);
    act(() => {
      jest.runOnlyPendingTimers();
      root.unmount();
    });

    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
