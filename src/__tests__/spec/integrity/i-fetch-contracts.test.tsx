import { act } from 'react';
import { configureDb, defineFetch, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, isTestNetworkOnline, renderCountedInProvider, setTestFocused, setTestNetworkOnline, settle } from '../helpers/harness';

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
    const rows = defineModel({
      id: 'SpecFetchContractsRows',
      name: 'SpecFetchContractsRows',
      fields: { bucket: f.str(), version: f.num() },
      scopes: { byBucket: scope<Row>({ by: { bucket: 'bucket' } }) }
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
      setTestFocused(true);
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
          networkMode: 'offlineFirst',
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
        setTestFocused(true);
        setTestNetworkOnline(false);
      });
      pending.shift()?.reject(new Error('offline'));
      await settle(6, { macro: true });

      expect(calls).toBe(1);
      act(() => {
        setTestFocused(true);
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
