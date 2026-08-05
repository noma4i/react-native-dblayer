import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind, OperationTypeNode } from 'graphql';
import React, { act } from 'react';
import { AppState } from 'react-native';
import TestRenderer from 'react-test-renderer';
import * as dbl from '../../testApi';
import { compositeStorageKey, createMemoryPlane, createMockTransport, setupSpecRuntime, settle } from '../helpers/harness';

type EmptyVariables = Record<string, never>;

type UserRow = {
  id: string;
  name: string;
};

type ScreenData = {
  rows: UserRow[];
};

type SingleValueData = {
  value: string;
};

type SingleValueRow = {
  id: string;
  value: string;
};

type EventPayload = {
  value: string;
};

type EventData = {
  event: EventPayload;
};

const screenDocument: TypedDocumentNode<ScreenData, EmptyVariables> = {
  kind: Kind.DOCUMENT,
  definitions: []
};

const singleValueDocument: TypedDocumentNode<SingleValueData, EmptyVariables> = {
  kind: Kind.DOCUMENT,
  definitions: []
};

const eventDocument: TypedDocumentNode<EventData, EmptyVariables> = {
  kind: Kind.DOCUMENT,
  definitions: [
    {
      kind: Kind.OPERATION_DEFINITION,
      operation: OperationTypeNode.SUBSCRIPTION,
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: [
          {
            kind: Kind.FIELD,
            name: { kind: Kind.NAME, value: 'event' }
          }
        ]
      }
    }
  ]
};

const UserSchema = dbl.defineShape<UserRow>()({ name: dbl.f.str() });
const SingleValueSchema = dbl.defineShape<SingleValueRow>()({ value: dbl.f.str() });

const createSingleValueRelation = (key: string) => {
  const Model = dbl.defineModel(key, {
    schema: SingleValueSchema,
    relations: owner => ({
      value: {
        remote: owner.gql.single(singleValueDocument, {
          variables: (_params: EmptyVariables) => ({}),
          select: data => ({ id: key, value: data.value })
        })
      }
    })
  });
  return Model.value({});
};

const DbProvider = dbl.DbProvider;

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
  let appStateHandler: Parameters<typeof AppState.addEventListener>[1] | undefined;
  let removeAppStateListener: jest.Mock;

  beforeEach(() => {
    removeAppStateListener = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      appStateHandler = handler;
      return { remove: removeAppStateListener };
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('gates children until boot completes and then supports DSL reads', async () => {
    setupSpecRuntime();
    const users = dbl.defineModel('SpecProviderBoot', { schema: UserSchema });
    dbl.writePersistenceManifest('dbl:', {
      formatVersion: dbl.DB_FORMAT_VERSION,
      schemaFingerprints: dbl.computeSchemaFingerprints(),
      dataVersion: null
    });
    users.insert({ id: 'user', name: 'Ready' });
    let renders = 0;
    let value: string | undefined;
    const Child = () => {
      renders += 1;
      value = users.useFind('user')?.name;
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
        resolveBoot = () => resolve({ maintenance: [], reset: false });
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
      .mockResolvedValueOnce({ maintenance: [], reset: false });
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
      resolveFirstBoot = () => resolve({ maintenance: [], reset: false });
    });
    const boot = jest
      .spyOn(dbl.lifecycleModule, 'bootDb')
      .mockReturnValueOnce(firstBoot)
      .mockResolvedValueOnce({ maintenance: [], reset: false });
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
    dbl.registerBootValidation('s03-probe', () => {
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
    dbl.registerBootValidation('s03-probe', () => {});
  });

  it('lands coalesced cache snapshots on background and drains readers after background or inactive', async () => {
    const { storage } = setupSpecRuntime();
    const users = dbl.defineModel('SpecProviderBackground', { schema: UserSchema });
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

    act(() => appStateHandler?.('background'));
    // Backgrounding lands every coalesced cache snapshot: the row is durable before a possible kill.
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
    dbl.configureDb({ storage, transport: createMockTransport() });
    dbl.defineModel('SpecProviderGenerationFence', { schema: UserSchema });

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
    dbl.configureDb({ storage: createMemoryPlane(), transport });
    const users = dbl.defineModel('SpecProviderReset', {
      schema: UserSchema,
      relations: owner => ({
        screen: {
          remote: owner.gql.list(screenDocument, {
            variables: (_params: EmptyVariables) => ({}),
            select: data => data.rows
          })
        }
      })
    });
    const relation = users.screen({});
    const Reader = () => {
      relation.use();
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
      query: async <TData,>() =>
        new Promise<{ data: TData }>(done => {
          resolve = value => done(value as { data: TData });
        })
    });
    dbl.configureDb({ storage: createMemoryPlane(), transport });
    const relation = createSingleValueRelation('SpecProviderFence');
    const pending = relation.fetch();

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
    dbl.configureDb({ storage: createMemoryPlane(), transport });
    const received: string[] = [];
    const runtime = dbl.createModelEventLifecycle<EventPayload>([
      { key: 'event', query: eventDocument, onData: payload => received.push(payload.value) }
    ]);

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
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { value: String(calls) } as TData };
      }
    });
    dbl.configureDb({ storage: createMemoryPlane(), transport });
    const relation = createSingleValueRelation('SpecProviderIdentity');
    let mounts = 0;
    let unmounts = 0;
    const Child = () => {
      relation.use();
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
