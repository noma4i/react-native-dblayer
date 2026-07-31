import { act } from 'react';
import { configureDb, defineFetch, defineModelRuntime, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, isTestNetworkOnline, renderCountedInProvider, setTestNetworkOnline, settle } from '../helpers/harness';

type FetchPayload = { value: string };
type Row = { id: string; bucket: string; version: number };
type QueryResponse = { rows: Row[] };
type ScopeValue = { bucket: string };

const document = { kind: 'Document', definitions: [] } as never;

const createFetch = (key: string, calls: { count: number }) =>
  defineFetch<FetchPayload, string, string>({
    key,
    fetcher: async input => {
      calls.count += 1;
      return { value: input };
    },
    select: data => data.value,
    staleTime: 1_000
  });

describe('fetch lifecycle contracts', () => {
  it('assigns independent generated keys and serves a sequential fresh cache hit', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    let firstCalls = 0;
    let secondCalls = 0;
    const first = defineFetch<FetchPayload, string, string>({
      fetcher: async input => ({ value: `${input}-${++firstCalls}` }),
      select: data => data.value,
      staleTime: Infinity
    });
    const second = defineFetch<FetchPayload, string, string>({
      fetcher: async input => ({ value: `${input}-${++secondCalls}` }),
      select: data => data.value,
      staleTime: Infinity
    });

    await expect(first.fetch('first')).resolves.toBe('first-1');
    await expect(first.fetch('first')).resolves.toBe('first-1');
    await expect(second.fetch('first')).resolves.toBe('first-1');
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 1, secondCalls: 1 });
  });

  it('normalizes a non-Error imperative failure', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const request = defineFetch<FetchPayload, void, string>({
      key: 'fetch-non-error-failure',
      fetcher: async () => Promise.reject('string failure'),
      select: data => data.value
    });

    await expect(request.fetch(undefined)).rejects.toThrow('string failure');
  });

  it('drops a response when selection advances the runtime generation', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const request = defineFetch<FetchPayload, void, string>({
      key: 'fetch-select-reset-fence',
      fetcher: async () => ({ value: 'stale' }),
      select: data => {
        resetRuntime();
        return data.value;
      }
    });

    await expect(request.fetch(undefined)).rejects.toThrow('runtime was reset before it resolved');
  });

  it('normalizes a non-Error reader failure and observes the rejected mount run', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const request = defineFetch<FetchPayload, void, string>({
      key: 'fetch-reader-non-error',
      fetcher: async () => Promise.reject('reader string failure'),
      select: data => data.value
    });
    const reader = renderCountedInProvider(() => request.use(undefined));

    await settle(6, { macro: true });

    expect(reader.result().error).toBeInstanceOf(Error);
    expect(reader.result().error?.message).toBe('reader string failure');
    reader.unmount();
  });

  it('observes a rejected reconnect run after an offline mount', async () => {
    const wasOnline = isTestNetworkOnline();
    try {
      setTestNetworkOnline(false);
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const request = defineFetch<FetchPayload, void, string>({
        key: 'fetch-reconnect-rejection',
        fetcher: async () => {
          throw new Error('reconnect failure');
        },
        select: data => data.value
      });
      const reader = renderCountedInProvider(() => request.use(undefined));
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

  it('keeps only the latest of consecutive reader restarts', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const pending: Array<(value: FetchPayload) => void> = [];
    const request = defineFetch<FetchPayload, void, string>({
      key: 'fetch-consecutive-restarts',
      fetcher: () =>
        new Promise(resolve => {
          pending.push(resolve);
        }),
      select: data => data.value
    });
    const reader = renderCountedInProvider(() => request.use(undefined));
    await settle(2);
    expect(pending).toHaveLength(1);

    act(() => reader.result().refresh());
    await settle(2);
    expect(pending).toHaveLength(2);
    act(() => reader.result().refresh());
    await settle(2);
    expect(pending).toHaveLength(3);

    pending[0]!({ value: 'first' });
    pending[1]!({ value: 'second' });
    pending[2]!({ value: 'latest' });
    await settle(6, { macro: true });

    expect(reader.result().data).toBe('latest');
    reader.unmount();
  });

  it('drops a rejected reader restart after the runtime generation changes', async () => {
    let calls = 0;
    let rejectRestart!: (error: Error) => void;
    const onSyncError = jest.fn();
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport(), defaults: { onSyncError } });
    const request = defineFetch<FetchPayload, void, string>({
      key: 'fetch-reader-reset-rejection',
      enabled: () => false,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return { value: 'cached' };
        return await new Promise((_resolve, reject) => {
          rejectRestart = reject;
        });
      },
      select: data => data.value,
      staleTime: Infinity
    });
    await expect(request.fetch(undefined)).resolves.toBe('cached');
    const reader = renderCountedInProvider(() => request.use(undefined));
    await settle(2);
    expect(reader.result().data).toBe('cached');

    act(() => reader.result().refresh());
    await settle(2);
    resetRuntime();
    rejectRestart(new Error('stale reader restart'));
    await settle(2);

    expect(onSyncError).not.toHaveBeenCalled();
    reader.unmount();
  });

  it('F1 coalesces two concurrent fetches for one input into one transport call', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const calls = { count: 0 };
    const request = createFetch('f1-single-flight', calls);

    await expect(Promise.all([request.fetch('same'), request.fetch('same')])).resolves.toEqual(['same', 'same']);

    expect(calls.count).toBe(1);
  });

  it('F2 keeps concurrent fetches for different inputs independent', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const calls = { count: 0 };
    const request = createFetch('f2-distinct-inputs', calls);

    await expect(Promise.all([request.fetch('first'), request.fetch('second')])).resolves.toEqual(['first', 'second']);

    expect(calls.count).toBe(2);
  });

  it('F3 does not fetch again when a reader remounts inside its freshness window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const calls = { count: 0 };
      const request = createFetch('f3-fresh-remount', calls);

      const first = renderCountedInProvider(() => request.use('same'));
      await settle();
      expect(calls.count).toBe(1);
      first.unmount();

      act(() => {
        jest.advanceTimersByTime(999);
      });
      const second = renderCountedInProvider(() => request.use('same'));
      await settle();

      expect(calls.count).toBe(1);
      second.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('F4 fetches exactly once after a reader remounts beyond its freshness window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    try {
      configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
      const calls = { count: 0 };
      const request = createFetch('f4-stale-remount', calls);

      const first = renderCountedInProvider(() => request.use('same'));
      await settle();
      expect(calls.count).toBe(1);
      first.unmount();

      act(() => {
        jest.advanceTimersByTime(1_001);
      });
      const second = renderCountedInProvider(() => request.use('same'));
      await settle();

      expect(calls.count).toBe(2);
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
    const rows = defineModelRuntime({
      id: 'SpecFetchContractsRows',
      name: 'SpecFetchContractsRows',
      fields: { bucket: f.str(), version: f.num() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    const request = rows.query<QueryResponse, ScopeValue, ScopeValue, Row>('f5-invalidate', {
      document,
      vars: value => value,
      select: data => data.rows,
      into: rows.scopes.byBucket,
      staleTime: Number.MAX_SAFE_INTEGER
    });
    const reader = renderCountedInProvider(() => request.use({ bucket: 'a' }));

    await settle();
    expect(calls).toBe(1);
    expect(rows.scopes.byBucket.read({ bucket: 'a' }).map(row => row.version)).toEqual([1]);

    act(() => {
      request.invalidate({ bucket: 'a' });
    });
    await settle();

    expect(calls).toBe(2);
    expect(rows.scopes.byBucket.read({ bucket: 'a' }).map(row => row.version)).toEqual([2]);
    reader.unmount();
  });

  it('F8 keeps transport idle while offline and resumes it after connectivity returns', async () => {
    const wasOnline = isTestNetworkOnline();
    const pending: Array<{ resolve: (value: FetchPayload) => void; reject: (error: Error) => void }> = [];
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
      const request = defineFetch<FetchPayload, void, string>({
        key: 'f8-offline-reconnect',
        document,
        select: data => data.value
      });
      const reader = renderCountedInProvider(() => request.use(undefined));

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
      expect(reader.result().data).toBe('recovered');
      reader.unmount();
    } finally {
      setTestNetworkOnline(wasOnline);
    }
  });
});
