import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, isTestNetworkOnline, recordTimelineInProvider, setTestNetworkOnline, settle } from '../helpers/harness';

type ResponseData = { value: number };
type ResultRow = { id: string; value: number };
type Deferred = { resolve: (data: ResponseData) => void; reject: (error: Error) => void };
type Variables = Record<string, never>;

const document: TypedDocumentNode<ResponseData, Variables> = { kind: Kind.DOCUMENT, definitions: [] };
const ResultSchema = defineShape<ResultRow>()({ value: f.num() });

const createDeferredTransport = () => {
  const pending: Deferred[] = [];
  const transport = createMockTransport({
    query: async <TData,>() =>
      await new Promise<{ data: TData }>((resolve, reject) => {
        pending.push({ resolve: data => resolve({ data: data as TData }), reject });
      })
  });
  return { pending, transport };
};

const configureRetry = (transport: ReturnType<typeof createMockTransport>) => {
  configureDb({
    storage: createMemoryPlane(),
    transport,
    defaults: {
      retry: { query: { classify: () => 'retriable', budgets: { retriable: 2 }, backoff: { baseMs: 1, maxMs: 2 } } }
    }
  });
};

const createRequest = (key: string) => {
  const Model = defineModel(key, {
    schema: ResultSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.single(document, {
          variables: () => ({}),
          select: data => ({ id: key, value: data.value })
        })
      }
    })
  });
  return Model.result({});
};

describe('network resilience timelines', () => {
  it('holds loading through error -> retrying -> data without empty or error flash', async () => {
    setTestNetworkOnline(true);
    const { pending, transport } = createDeferredTransport();
    configureRetry(transport);
    const request = createRequest('resilience-retry-no-flash');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use();
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    setTestNetworkOnline(true);
    pending.shift()?.reject(new Error('first failure'));
    await settle(6, { macro: true });
    const retryFrames = timeline.frames();
    pending.shift()?.resolve({ value: 1 });
    await settle(6, { macro: true });

    expect(retryFrames.some(frame => frame.isRetrying && frame.retryAttempt > 0)).toBe(true);
    expect(timeline.frames().some(frame => frame.showEmptyState || frame.showErrorBanner)).toBe(false);
    expect(timeline.last()).toMatchObject({ showData: true, showEmptyState: false, showErrorBanner: false });
    timeline.unmount();
  });

  it('increments retryAttempt for each failed attempt and clears it after success', async () => {
    setTestNetworkOnline(true);
    const { pending, transport } = createDeferredTransport();
    configureRetry(transport);
    const request = createRequest('resilience-retry-count');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use();
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    setTestNetworkOnline(true);
    pending.shift()?.reject(new Error('first failure'));
    await settle(6, { macro: true });
    pending.shift()?.reject(new Error('second failure'));
    await settle(6, { macro: true });
    const attempts = timeline.frames().filter(frame => frame.isRetrying).map(frame => frame.retryAttempt);
    pending.shift()?.resolve({ value: 2 });
    await settle(6, { macro: true });

    expect(attempts).toEqual(expect.arrayContaining([1, 2]));
    expect(timeline.last()).toMatchObject({ retryAttempt: 0, isRetrying: false, showData: true });
    timeline.unmount();
  });

  it('holds loading while offline and automatically recovers when online', async () => {
    const wasOnline = isTestNetworkOnline();
    setTestNetworkOnline(true);
    const { pending, transport } = createDeferredTransport();
    configureRetry(transport);
    const request = createRequest('resilience-offline-recover');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use();
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    setTestNetworkOnline(true);
    setTestNetworkOnline(false);
    pending.shift()?.reject(new Error('offline'));
    await settle(6, { macro: true });
    const pausedFrames = timeline.frames();
    setTestNetworkOnline(true);
    await settle(6, { macro: true });
    pending.shift()?.resolve({ value: 3 });
    await settle(6, { macro: true });

    expect(pausedFrames.some(frame => frame.isOffline)).toBe(true);
    expect(timeline.frames().some(frame => frame.showEmptyState || frame.showErrorBanner)).toBe(false);
    expect(timeline.last()).toMatchObject({ isOffline: false, showData: true });
    timeline.unmount();
    setTestNetworkOnline(wasOnline);
  });

  it('recovers from a terminal error through the public refetch surface', async () => {
    const { pending, transport } = createDeferredTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const request = createRequest('resilience-manual-retry');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use();
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    pending.shift()?.reject(new Error('terminal failure'));
    await settle(6, { macro: true });
    const recoveryStart = timeline.frames().length;
    act(() => {
      void request.refresh();
    });
    await settle(6, { macro: true });
    pending.shift()?.resolve({ value: 4 });
    await settle(6, { macro: true });

    expect(timeline.frames()[recoveryStart - 1]).toMatchObject({ showErrorBanner: true, hasData: false });
    expect(timeline.frames().slice(recoveryStart).some(frame => frame.showEmptyState)).toBe(false);
    expect(timeline.last()).toMatchObject({ showData: true, showErrorBanner: false, hasData: true });
    timeline.unmount();
  });

  it('[F14] rejects an offline model relation fetch when nothing was restored', async () => {
    const wasOnline = isTestNetworkOnline();
    setTestNetworkOnline(false);
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage, transport });
    const request = createRequest('resilience-offline-imperative');
    const keysBefore = storage.snapshotKeys();

    await expect(request.fetch()).rejects.toThrow('react-native-dblayer: fetch is offline and no cached data exists');

    expect(transport.calls).toHaveLength(0);
    expect(request.read()).toBeUndefined();
    expect(storage.snapshotKeys()).toEqual(keysBefore);
    setTestNetworkOnline(wasOnline);
  });

  it('[F15] keeps served data on a stale fetch error while refresh reports the failure', async () => {
    setTestNetworkOnline(true);
    let failing = false;
    const transport = createMockTransport({
      query: async <TData,>() => {
        if (failing) throw new Error('transport down');
        return { data: { value: 5 } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const request = createRequest('resilience-stale-fetch-keeps');

    await expect(request.fetch()).resolves.toBeUndefined();
    expect(request.read()?.value).toBe(5);

    failing = true;
    // Actual contract: a failed non-restart fetch over a cached bucket resolves silently and keeps the served rows.
    await expect(request.fetch()).resolves.toBeUndefined();
    expect(request.read()?.value).toBe(5);

    await expect(request.refresh()).rejects.toThrow('transport down');
    expect(request.read()?.value).toBe(5);
    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(3);
  });
});
