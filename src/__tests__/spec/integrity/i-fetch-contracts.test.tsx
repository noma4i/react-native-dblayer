import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f, resetRuntime, type DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, isTestNetworkOnline, renderCountedInProvider, setTestNetworkOnline, settle } from '../helpers/harness';

type FetchData = { value: string };
type FetchVariables = { input?: string };
type ResultRow = { id: string; value: string };
type ScopeRow = { id: string; bucket: string; version: number };
type ScopeData = { rows: ScopeRow[] };
type ScopeValue = { bucket: string };
type ResultSelect = (data: FetchData) => ResultRow | null | undefined;

const document: TypedDocumentNode<FetchData, FetchVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const listDocument: TypedDocumentNode<ScopeData, ScopeValue> = { kind: Kind.DOCUMENT, definitions: [] };
const ResultSchema = defineShape<ResultRow>()({ value: f.str() });
const ScopeSchema = defineShape<ScopeRow>()({ bucket: f.str(), version: f.num() });

const readInput = (operation: Parameters<DbTransport['query']>[0]): string => {
  const variables = operation.variables;
  if (variables == null || typeof variables !== 'object' || !('input' in variables)) return '';
  const input = variables.input;
  return typeof input === 'string' ? input : '';
};

const createFixture = (
  key: string,
  staleTime?: number,
  select: ResultSelect = data => ({ id: data.value, value: data.value })
) => {
  const Model = defineModel(key, {
    schema: ResultSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.single(document, {
          variables: (params: FetchVariables) => params,
          select,
          staleTime
        })
      }
    })
  });
  return (params: FetchVariables) => Model.result(params);
};

describe('fetch lifecycle contracts', () => {
  it('normalizes a non-Error imperative failure', async () => {
    const transport = createMockTransport({
      query: async <_TData,>() => Promise.reject('string failure')
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const relation = createFixture('fetch-non-error-failure')({});

    await expect(relation.fetch()).rejects.toThrow('string failure');
  });

  it('drops a response when selection advances the runtime generation', async () => {
    const transport = createMockTransport({
      query: async <_TData,>() => ({ data: { value: 'stale' } as _TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const relation = createFixture('fetch-select-reset-fence', undefined, data => {
      resetRuntime();
      return { id: 'fetch-select-reset-fence', value: data.value };
    })({});

    await expect(relation.fetch()).rejects.toThrow('runtime was reset before it resolved');
  });

  it('normalizes a non-Error reader failure and observes the rejected mount run', async () => {
    const transport = createMockTransport({
      query: async <_TData,>() => Promise.reject('reader string failure')
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const relation = createFixture('fetch-reader-non-error')({});
    const reader = renderCountedInProvider(() => relation.use());

    await settle(6, { macro: true });

    expect(reader.result().error).toBeInstanceOf(Error);
    expect(reader.result().error?.message).toBe('reader string failure');
    reader.unmount();
  });

  it('observes a rejected reconnect run after an offline mount', async () => {
    const wasOnline = isTestNetworkOnline();
    try {
      setTestNetworkOnline(false);
      const transport = createMockTransport({
        query: async <_TData,>() => {
          throw new Error('reconnect failure');
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const relation = createFixture('fetch-reconnect-rejection')({});
      const reader = renderCountedInProvider(() => relation.use());
      await settle();
      expect(reader.result().loadingState.isOffline).toBe(true);

      act(() => setTestNetworkOnline(true));
      await settle(6, { macro: true });

      expect(reader.result().error?.message).toBe('reconnect failure');
      reader.unmount();
    } finally {
      setTestNetworkOnline(wasOnline);
    }
  });

  it('[F6] keeps only the latest of consecutive reader restarts', async () => {
    const pending: Array<(value: FetchData) => void> = [];
    const transport = createMockTransport({
      query: async <TData,>() =>
        await new Promise<{ data: TData }>(resolve => {
          pending.push(value => resolve({ data: value as TData }));
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const relation = createFixture('fetch-consecutive-restarts')({});
    const reader = renderCountedInProvider(() => relation.use());
    await settle(2);
    expect(pending).toHaveLength(1);

    act(() => {
      void relation.refresh();
    });
    await settle(2);
    expect(pending).toHaveLength(2);
    act(() => {
      void relation.refresh();
    });
    await settle(2);
    expect(pending).toHaveLength(3);

    pending[0]!({ value: 'first' });
    pending[1]!({ value: 'second' });
    pending[2]!({ value: 'latest' });
    await settle(6, { macro: true });

    expect(reader.result().data?.value).toBe('latest');
    reader.unmount();
  });

  it('drops a rejected reader restart after the runtime generation changes', async () => {
    let calls = 0;
    let rejectRestart!: (error: Error) => void;
    let refreshOutcome!: Promise<unknown>;
    const onSyncError = jest.fn();
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        if (calls === 1) return { data: { value: 'cached' } as TData };
        return await new Promise<{ data: TData }>((_resolve, reject) => {
          rejectRestart = reject;
        });
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const relation = createFixture('fetch-reader-reset-rejection', Infinity)({});
    await expect(relation.fetch()).resolves.toBeUndefined();
    expect(relation.read()?.value).toBe('cached');
    const reader = renderCountedInProvider(() => relation.use({ enabled: false }));
    await settle(2);
    expect(calls).toBe(1);

    act(() => {
      refreshOutcome = relation.refresh().then(
        () => undefined,
        error => error
      );
    });
    await settle(2);
    resetRuntime();
    rejectRestart(new Error('stale reader restart'));
    await settle(2);

    await expect(refreshOutcome).resolves.toMatchObject({ message: 'react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved' });
    expect(onSyncError).not.toHaveBeenCalled();
    reader.unmount();
  });

  it('F1 coalesces two concurrent fetches for one input into one transport call', async () => {
    const transport = createMockTransport({
      query: async <TData, _TVariables>(operation: Parameters<DbTransport['query']>[0]) => ({
        data: { value: readInput(operation) } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const relation = createFixture('f1-single-flight', 1_000);
    const first = relation({ input: 'same' });
    const second = relation({ input: 'same' });

    await expect(Promise.all([first.fetch(), second.fetch()])).resolves.toEqual([undefined, undefined]);

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(1);
    expect(first.read()?.value).toBe('same');
  });

  it('F2 keeps concurrent fetches for different inputs independent', async () => {
    const transport = createMockTransport({
      query: async <TData, _TVariables>(operation: Parameters<DbTransport['query']>[0]) => ({
        data: { value: readInput(operation) } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const relation = createFixture('f2-distinct-inputs', 1_000);
    const first = relation({ input: 'first' });
    const second = relation({ input: 'second' });

    await expect(Promise.all([first.fetch(), second.fetch()])).resolves.toEqual([undefined, undefined]);

    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(2);
    expect(first.read()?.value).toBe('first');
    expect(second.read()?.value).toBe('second');
  });

  it('F3 does not fetch again when a reader remounts inside its freshness window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    try {
      let calls = 0;
      const transport = createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          return { data: { value: 'same' } as TData };
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const relation = createFixture('f3-fresh-remount', 1_000)({ input: 'same' });

      const first = renderCountedInProvider(() => relation.use());
      await settle();
      expect(calls).toBe(1);
      first.unmount();

      act(() => {
        jest.advanceTimersByTime(999);
      });
      const second = renderCountedInProvider(() => relation.use());
      await settle();

      expect(calls).toBe(1);
      second.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('F4 fetches exactly once after a reader remounts beyond its freshness window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    try {
      let calls = 0;
      const transport = createMockTransport({
        query: async <TData,>() => {
          calls += 1;
          return { data: { value: 'same' } as TData };
        }
      });
      configureDb({ storage: createMemoryPlane(), transport });
      const relation = createFixture('f4-stale-remount', 1_000)({ input: 'same' });

      const first = renderCountedInProvider(() => relation.use());
      await settle();
      expect(calls).toBe(1);
      first.unmount();

      act(() => {
        jest.advanceTimersByTime(1_001);
      });
      const second = renderCountedInProvider(() => relation.use());
      await settle();

      expect(calls).toBe(2);
      second.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('F5 invalidates one active scope into exactly one refetch', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { rows: [{ id: 'row-1', bucket: 'a', version: calls }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel('SpecFetchContractsRows', {
      schema: ScopeSchema,
      relations: owner => ({
        byBucket: {
          by: { bucket: 'bucket' },
          remote: owner.gql.list(listDocument, {
            variables: (scope: ScopeValue) => scope,
            select: data => data.rows,
            staleTime: Number.MAX_SAFE_INTEGER
          })
        }
      })
    });
    const relation = rows.byBucket({ bucket: 'a' });
    const reader = renderCountedInProvider(() => relation.use());

    await settle();
    expect(calls).toBe(1);
    expect(relation.read().map(row => row.version)).toEqual([1]);

    act(() => {
      relation.invalidate();
    });
    await settle();

    expect(calls).toBe(2);
    expect(relation.read().map(row => row.version)).toEqual([2]);
    reader.unmount();
  });

  it('[F5] runs no transport when an invalidation lands with no mounted reader', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { rows: [{ id: 'row-1', bucket: 'a', version: calls }] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModel('SpecFetchContractsIdleRows', {
      schema: ScopeSchema,
      relations: owner => ({
        byBucket: {
          by: { bucket: 'bucket' },
          remote: owner.gql.list(listDocument, {
            variables: (scope: ScopeValue) => scope,
            select: data => data.rows,
            staleTime: Number.MAX_SAFE_INTEGER
          })
        }
      })
    });
    const relation = rows.byBucket({ bucket: 'a' });
    const seeded = renderCountedInProvider(() => relation.use());
    await settle();
    expect(calls).toBe(1);
    seeded.unmount();

    act(() => {
      relation.invalidate();
    });
    await settle();

    expect(calls).toBe(1);

    const reader = renderCountedInProvider(() => relation.use());
    await settle();

    expect(calls).toBe(2);
    expect(relation.read().map(row => row.version)).toEqual([2]);
    reader.unmount();
  });

  it('F8 keeps transport idle while offline and resumes it after connectivity returns', async () => {
    const wasOnline = isTestNetworkOnline();
    const pending: Array<{ resolve: (value: FetchData) => void; reject: (error: Error) => void }> = [];
    try {
      setTestNetworkOnline(true);
      let calls = 0;
      const transport = createMockTransport({
        query: async <TData,>() =>
          await new Promise<{ data: TData }>((resolve, reject) => {
            calls += 1;
            pending.push({ resolve: value => resolve({ data: value as TData }), reject });
          })
      });
      configureDb({
        storage: createMemoryPlane(),
        transport,
        defaults: {
          retry: { query: { classify: () => 'retriable', budgets: { retriable: 1 }, backoff: { baseMs: 1, maxMs: 1 } } }
        }
      });
      const relation = createFixture('f8-offline-reconnect')({});
      const reader = renderCountedInProvider(() => relation.use());

      await settle(6, { macro: true });
      expect(calls).toBe(1);
      act(() => {
        setTestNetworkOnline(false);
      });
      pending.shift()?.reject(new Error('offline'));
      await settle(6, { macro: true });

      expect(calls).toBe(1);
      act(() => {
        setTestNetworkOnline(true);
      });
      await settle(6, { macro: true });

      expect(calls).toBe(2);
      pending.shift()?.resolve({ value: 'recovered' });
      await settle(6, { macro: true });
      expect(reader.result().data?.value).toBe('recovered');
      reader.unmount();
    } finally {
      setTestNetworkOnline(wasOnline);
    }
  });
});
