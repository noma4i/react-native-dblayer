import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { configureDb, QueryClient, resetRuntime, type DbTransport, type StoragePlane } from '../../../index';

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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configureDb({ storage, transport, queryClient });
  return { storage, transport, queryClient };
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

afterEach(() => {
  resetRuntime();
});
