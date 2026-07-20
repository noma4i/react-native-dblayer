import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, resetRuntime, type DbTransport, type StoragePlane } from '../../../index';

export function createMemoryPlane(): StoragePlane & { snapshotKeys: () => string[] } {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => {
      for (const entry of entries) {
        if (entry.value === null) values.delete(entry.key);
        else values.set(entry.key, entry.value);
      }
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
    snapshotKeys: () => [...values.keys()].sort()
  };
}

type TransportCall = {
  kind: 'query' | 'mutation' | 'subscribe';
  operation: unknown;
};

export function createMockTransport(handlers: Partial<DbTransport> = {}) {
  const calls: TransportCall[] = [];
  const unexpected = (kind: TransportCall['kind']) => Promise.reject(new Error(`unexpected transport ${kind} call`));

  return {
    calls,
    query: <TData, TVariables>(operation: Parameters<DbTransport['query']>[0]) => {
      calls.push({ kind: 'query', operation });
      return handlers.query ? handlers.query<TData, TVariables>(operation as never) : unexpected('query');
    },
    mutation: <TData, TVariables>(operation: Parameters<DbTransport['mutation']>[0]) => {
      calls.push({ kind: 'mutation', operation });
      return handlers.mutation ? handlers.mutation<TData, TVariables>(operation as never) : unexpected('mutation');
    },
    subscribe: (options: Parameters<NonNullable<DbTransport['subscribe']>>[0], handlersArg: Parameters<NonNullable<DbTransport['subscribe']>>[1]) => {
      calls.push({ kind: 'subscribe', operation: options });
      return handlers.subscribe
        ? handlers.subscribe(options, handlersArg)
        : () => {
            void unexpected('subscribe');
          };
    }
  } satisfies DbTransport & { calls: TransportCall[] };
}

export function setupSpecRuntime() {
  const storage = createMemoryPlane();
  const transport = createMockTransport();
  configureDb({ storage, transport });
  return { storage, transport };
}

export function renderCounted<T>(useHook: () => T) {
  let value!: T;
  let renderCount = 0;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    value = useHook();
    renderCount += 1;
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(Reader));
  });

  return {
    result: () => value,
    renders: () => renderCount,
    unmount: () => act(() => root.unmount())
  };
}

/**
 * Record every rendered value of a hook in order, so a test can assert the FRAME SEQUENCE
 * (not just the final value). Use for transient-state contracts: e.g. a loading hook must never
 * emit an empty-state frame while a fetch is in flight.
 */
export function recordTimeline<T>(useHook: () => T) {
  const frames: T[] = [];
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    frames.push(useHook());
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(Reader));
  });

  return {
    frames: () => frames,
    last: () => frames[frames.length - 1],
    unmount: () => act(() => root.unmount())
  };
}

/**
 * Same as `recordTimeline` but renders the hook inside `DbProvider`, for hooks that require the
 * owned QueryClient / boot gate (query/fetch/ensured-row reads). Frames begin once the boot gate
 * releases children.
 */
export function recordTimelineInProvider<T>(useHook: () => T) {
  const frames: T[] = [];
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    frames.push(useHook());
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });

  return {
    frames: () => frames,
    last: () => frames[frames.length - 1],
    unmount: () => act(() => root.unmount())
  };
}

afterEach(() => {
  resetRuntime();
});
