import { act } from 'react-test-renderer';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { configureDb, defineFetch } from '../../../index';
import { createMemoryPlane, createMockTransport, recordTimelineInProvider, settle } from '../helpers/harness';

type Response = { value: number };
type Deferred = { resolve: (data: Response) => void; reject: (error: Error) => void };

const document = { kind: 'Document', definitions: [] } as never;

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

const configureRetry = (transport: ReturnType<typeof createMockTransport>, networkMode: 'offlineFirst' | 'online' | 'always' = 'always') => {
  configureDb({
    storage: createMemoryPlane(),
    transport,
    defaults: {
      networkMode: networkMode as never,
      retry: { query: { classify: () => 'retriable', budgets: { retriable: 2 }, backoff: { baseMs: 1, maxMs: 2 } } }
    }
  });
};

const createRequest = (key: string) => defineFetch<Response, void, number>({ document, key, select: data => data.value });

describe('network resilience timelines', () => {
  it('holds loading through error -> retrying -> data without empty or error flash', async () => {
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    const { pending, transport } = createDeferredTransport();
    configureRetry(transport);
    const request = createRequest('resilience-retry-no-flash');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use(undefined);
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
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
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    const { pending, transport } = createDeferredTransport();
    configureRetry(transport);
    const request = createRequest('resilience-retry-count');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use(undefined);
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
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
    const wasOnline = onlineManager.isOnline();
    const wasFocused = focusManager.isFocused();
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    const { pending, transport } = createDeferredTransport();
    configureRetry(transport, 'offlineFirst');
    const request = createRequest('resilience-offline-recover');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use(undefined);
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    onlineManager.setOnline(false);
    pending.shift()?.reject(new Error('offline'));
    await settle(6, { macro: true });
    const pausedFrames = timeline.frames();
    onlineManager.setOnline(true);
    await settle(6, { macro: true });
    pending.shift()?.resolve({ value: 3 });
    await settle(6, { macro: true });

    expect(pausedFrames.some(frame => frame.isOffline)).toBe(true);
    expect(timeline.frames().some(frame => frame.showEmptyState || frame.showErrorBanner)).toBe(false);
    expect(timeline.last()).toMatchObject({ isOffline: false, showData: true });
    timeline.unmount();
    onlineManager.setOnline(wasOnline);
    focusManager.setFocused(wasFocused);
  });

  it('recovers from a terminal error through the public refetch surface', async () => {
    const { pending, transport } = createDeferredTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const request = createRequest('resilience-manual-retry');
    let latest!: ReturnType<typeof request.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = request.use(undefined);
      return latest.loadingState;
    });

    await settle(6, { macro: true });
    pending.shift()?.reject(new Error('terminal failure'));
    await settle(6, { macro: true });
    const recoveryStart = timeline.frames().length;
    act(() => {
      latest.refetch();
    });
    await settle(6, { macro: true });
    pending.shift()?.resolve({ value: 4 });
    await settle(6, { macro: true });

    expect(timeline.frames()[recoveryStart - 1]).toMatchObject({ showErrorBanner: true, hasData: false });
    expect(timeline.frames().slice(recoveryStart).some(frame => frame.showEmptyState)).toBe(false);
    expect(timeline.last()).toMatchObject({ showData: true, showErrorBanner: false, hasData: true });
    timeline.unmount();
  });
});
