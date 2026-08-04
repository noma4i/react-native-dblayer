import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, resetRuntime, type DbTransport, type StoragePlane } from '../../testApi';
import { isFetchNetworkOnline, setFetchNetworkOnline } from '../../testApi';
export { compositeStorageKey } from '../../testApi';

export function createMemoryPlane(): StoragePlane & { snapshotKeys: () => string[] } {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
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

/** Test-only connectivity adapter. Query-engine migrations update this seam without changing contracts. */
export const setTestNetworkOnline = (online: boolean): void => {
  setFetchNetworkOnline(online);
};

/** Test-only connectivity adapter state. */
export const isTestNetworkOnline = (): boolean => isFetchNetworkOnline();

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

export function renderCountedInProvider<T>(useHook: () => T) {
  let value!: T;
  let renderCount = 0;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    value = useHook();
    renderCount += 1;
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });

  return {
    result: () => value,
    renders: () => renderCount,
    unmount: () => act(() => root.unmount())
  };
}

/** Drains microtasks by default (safe with fake timers); macro mode drains setTimeout work and must not run with fake timers. */
export const settle = async (ticks = 12, opts?: { macro?: boolean }): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await act(async () => {
      if (opts?.macro) await new Promise<void>(resolve => setTimeout(resolve, 0));
      else await Promise.resolve();
    });
  }
};

/** Ticks until `condition` holds, using the selected microtask or macro drain. */
export const settleUntil = async (condition: () => boolean, maxTicks = 50, opts?: { macro?: boolean }): Promise<void> => {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (condition()) return;
    await act(async () => {
      if (opts?.macro) await new Promise<void>(resolve => setTimeout(resolve, 0));
      else await Promise.resolve();
    });
  }
  if (!condition()) throw new Error(`settleUntil: condition still false after ${maxTicks} ticks`);
};

export type DiagnosticsSnapshot = {
  commits: number;
  commitFanoutCandidates: number;
  commitFanoutNotified: number;
  readEngineApplies: number;
  readEngineDeltaRows: number;
  readEngineScanRows: number;
  scopeReadPasses: number;
  scopeReadResorts: number;
  resumeDrains: number;
  resumeRefetches: number;
  entityUpsertGuardHits: number;
  membershipWrites: number;
  relationChildScans: number;
  corruptionJournalDrops: number;
  corruptionJournalLosses: number;
  corruptionLedgerResets: number;
  manifestResets: number;
  replaceRejected: number;
  applyFailure: number;
  dataLossEvents: Array<{ mechanism: string; model: string; count: number }>;
};

type DiagnosticsGlobal = { snapshot: () => DiagnosticsSnapshot; reset: () => void };

export const diagnostics = (): DiagnosticsGlobal => (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as DiagnosticsGlobal;

/**
 * Install the per-case check: an app-shaped flow ends having lost nothing. Twenty-five mechanisms can
 * discard rows, each tested only for firing in its OWN scenario; nothing asserted that a normal flow
 * fires none of them - which is the shape of the complaint that data randomly disappears.
 */
export const guardDataLoss = (): void => {
  afterEach(() => {
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });
};

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
 * owned boot gate (query/fetch/ensured-row reads). Frames begin once the boot gate
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
