import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { configureDb, defineModel, defineShape, f, resetRuntime, setFetchNetworkOnline, type DbRetryClass, backoffDelayMs } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type EmptyVariables = Record<string, never>;

type ValueData = {
  value: number;
};

type ValueRow = {
  id: string;
  value: number;
};

type RowsData = {
  rows: Row[];
};

type Row = {
  id: string;
  label: string;
};

const valueDocument: TypedDocumentNode<ValueData, EmptyVariables> = {
  kind: Kind.DOCUMENT,
  definitions: []
};

const rowsDocument: TypedDocumentNode<RowsData, EmptyVariables> = {
  kind: Kind.DOCUMENT,
  definitions: []
};

const ValueSchema = defineShape<ValueRow>()({ value: f.num() });
const RowSchema = defineShape<Row>()({ label: f.str() });

const createValueRelation = (key: string, options: { staleTime?: number } = {}) => {
  const Model = defineModel(key, {
    schema: ValueSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.single(valueDocument, {
          variables: (_params: EmptyVariables) => ({}),
          select: data => ({ id: key, value: data.value }),
          ...options
        })
      }
    })
  });
  return Model.result({});
};

const createRowsRelation = (key: string, options: { staleTime?: number } = {}) => {
  const Model = defineModel(key, {
    schema: RowSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.list(rowsDocument, {
          variables: (_params: EmptyVariables) => ({}),
          select: data => data.rows,
          ...options
        })
      }
    })
  });
  return Model.result({});
};

const configureRetry = (transport: ReturnType<typeof createMockTransport>, classify?: (error: unknown) => DbRetryClass) => {
  const queryRetry = {
    budgets: { network: 2 },
    backoff: { baseMs: 1, maxMs: 1 },
    ...(classify === undefined ? {} : { classify })
  };
  configureDb({
    storage: createMemoryPlane(),
    transport,
    defaults: {
      retry: { query: queryRetry }
    }
  });
};

describe('query retry policy', () => {
  it('rejects an offline relation when no data can be restored', async () => {
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const relation = createRowsRelation('OfflineEmptyRelation');
      setFetchNetworkOnline(false);

      await expect(relation.fetch()).rejects.toThrow('offline');
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('returns cached relation data while offline', async () => {
    try {
      let calls = 0;
      const transport = createMockTransport({
        query: async <TData>() => {
          calls += 1;
          return { data: { rows: [{ id: 'row-1', label: 'cached' }] } as TData };
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const relation = createRowsRelation('OfflineCachedRelation', { staleTime: 0 });

      await relation.fetch();
      setFetchNetworkOnline(false);

      await expect(relation.fetch()).resolves.toBeUndefined();
      expect(relation.read()).toEqual([{ id: 'row-1', label: 'cached' }]);
      expect(calls).toBe(1);
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('keeps cached relation data on a failed stale fetch but rejects refresh', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData>() => {
        calls += 1;
        if (calls === 1) return { data: { rows: [{ id: 'row-1', label: 'cached' }] } as TData };
        throw new Error('network failed');
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const relation = createRowsRelation('FailedCachedRelation', { staleTime: 0 });

    await relation.fetch();

    await expect(relation.fetch()).resolves.toBeUndefined();
    expect(relation.read()).toEqual([{ id: 'row-1', label: 'cached' }]);
    await expect(relation.refresh()).rejects.toThrow('network failed');
    expect(relation.read()).toEqual([{ id: 'row-1', label: 'cached' }]);
    expect(calls).toBe(3);
  });

  it('rejects a relation that loses connectivity before its first response', async () => {
    let rejectRequest!: (error: Error) => void;
    try {
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({
          query: () =>
            new Promise((_resolve, reject) => {
              rejectRequest = reject;
            })
        })
      });
      const relation = createRowsRelation('OfflineDuringEmptyRelation');
      const pending = relation.fetch();
      await Promise.resolve();
      setFetchNetworkOnline(false);
      rejectRequest(new Error('network dropped'));

      await expect(pending).rejects.toThrow('offline');
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('keeps cached relation data when connectivity drops during a stale request', async () => {
    let rejectRequest!: (error: Error) => void;
    let calls = 0;
    try {
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({
          query: async <TData>() => {
            calls += 1;
            if (calls === 1) return { data: { rows: [{ id: 'row-1', label: 'cached' }] } as TData };
            return await new Promise((_resolve, reject) => {
              rejectRequest = reject;
            });
          }
        })
      });
      const relation = createRowsRelation('OfflineDuringCachedRelation', { staleTime: 0 });
      await relation.fetch();
      const pending = relation.fetch();
      await Promise.resolve();
      setFetchNetworkOnline(false);
      rejectRequest(new Error('network dropped'));

      await expect(pending).resolves.toBeUndefined();
      expect(relation.read()).toEqual([{ id: 'row-1', label: 'cached' }]);
      expect(calls).toBe(2);
    } finally {
      setFetchNetworkOnline(true);
    }
  });

  it('doubles from the base delay and caps at the declared maximum', () => {
    expect([0, 1, 2, 3].map(attempt => backoffDelayMs(attempt, 100, 250))).toEqual([100, 200, 250, 250]);
  });

  it('retries a classified network failure within its budget', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData>() => {
        calls += 1;
        if (calls < 3) throw new Error('offline');
        return { data: { value: 42 } as TData };
      }
    });
    configureRetry(transport, () => 'network');
    const relation = createValueRelation('RetryNetworkRelation');

    await expect(relation.fetch()).resolves.toBeUndefined();
    expect(relation.read()).toEqual({ id: 'RetryNetworkRelation', value: 42 });
    expect(calls).toBe(3);
  });

  it('does not retry a fatal failure', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async () => {
        calls += 1;
        throw new Error('fatal');
      }
    });
    configureRetry(transport, () => 'fatal');
    const relation = createValueRelation('RetryFatalRelation');

    await expect(relation.fetch()).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('does not retry when no classifier is configured', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async () => {
        calls += 1;
        throw new Error('unclassified');
      }
    });
    configureRetry(transport);
    const relation = createValueRelation('RetryDefaultRelation');

    await expect(relation.fetch()).rejects.toThrow('unclassified');
    expect(calls).toBe(1);
  });

  it('[OP8] does not retry an old QueryClient after runtime reset', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const transport = createMockTransport({
        query: async () => {
          calls += 1;
          throw new Error('offline');
        }
      });
      configureDb({
        storage: createMemoryPlane(),
        transport,
        defaults: {
          retry: { query: { classify: () => 'network', budgets: { network: 2 }, backoff: { baseMs: 1000, maxMs: 1000 } } }
        }
      });
      const relation = createValueRelation('RetryResetFenceRelation');

      const pending = relation.fetch().then(
        () => null,
        error => error
      );
      await Promise.resolve();
      await Promise.resolve();
      resetRuntime();
      await jest.runAllTimersAsync();

      await expect(pending).resolves.toBeInstanceOf(Error);
      expect(calls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not report a stale relation failure after runtime reset', async () => {
    let rejectRequest!: (error: Error) => void;
    const onSyncError = jest.fn();
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        query: () =>
          new Promise((_resolve, reject) => {
            rejectRequest = reject;
          })
      }),
      defaults: { onSyncError }
    });
    const relation = createValueRelation('ErrorResetFenceRelation');
    const pending = relation.fetch().then(
      () => null,
      error => error
    );
    await Promise.resolve();

    resetRuntime();
    rejectRequest(new Error('stale relation failure'));
    await pending;

    expect(onSyncError).not.toHaveBeenCalled();
  });

  it('does not write stale relation pause state into the fresh generation', async () => {
    let rejectRequest!: (error: Error) => void;
    try {
      configureDb({
        storage: createMemoryPlane(),
        transport: createMockTransport({
          query: () =>
            new Promise((_resolve, reject) => {
              rejectRequest = reject;
            })
        })
      });
      const relation = createValueRelation('StateResetFenceRelation');
      const pending = relation.fetch().then(
        () => null,
        error => error
      );
      await Promise.resolve();

      resetRuntime();
      setFetchNetworkOnline(false);
      rejectRequest(new Error('stale relation failure'));
      await pending;
      const reader = renderCounted(() => relation.use({ enabled: false }));

      expect(reader.result().loadingState.isOffline).toBe(false);
      reader.unmount();
    } finally {
      setFetchNetworkOnline(true);
    }
  });
});
