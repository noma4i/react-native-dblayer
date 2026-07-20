import { act } from 'react-test-renderer';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, recordTimelineInProvider } from '../helpers/harness';

type Row = { id: string; groupId: string; status: string };
type ScopeValue = { groupId: string };
type Response = { row: Row };

type Deferred = {
  resolve: (data: Response) => void;
  reject: (error: Error) => void;
};

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const createRows = () =>
  defineModel({
    id: 'SpecConsumerLoadingMachine',
    name: 'SpecConsumerLoadingMachine',
    fields: {
      id: f.str(),
      groupId: f.id(),
      status: f.str()
    },
    scopes: {
      byGroup: scope<Row>({ by: { groupId: 'groupId' } })
    }
  });

const createDeferredQuery = () => {
  const pending: Deferred[] = [];
  const transport = createMockTransport({
    query: async <TData,>() =>
      await new Promise<{ data: TData }>((resolve, reject) => {
        pending.push({
          resolve: data => resolve({ data: data as TData }),
          reject
        });
      })
  });
  return { pending, transport };
};

describe('loading machine timeline contracts', () => {
  it('W-ERR-RETRY keeps the error banner stable across a retry while rows are retained', async () => {
    const { pending, transport } = createDeferredQuery();
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows();
    const query = rows.query<Response, ScopeValue, ScopeValue, Row>('loading-error-retry', {
      document,
      vars: value => value,
      select: data => data.row,
      into: rows.scopes.byGroup
    });
    let latest!: ReturnType<typeof query.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = query.use({ groupId: 'g' });
      return latest.loadingState;
    });

    await settle();
    pending.shift()?.resolve({ row: { id: 'row-1', groupId: 'g', status: 'active' } });
    await settle();

    void latest.refetch().catch(() => undefined);
    await settle();
    expect(pending).toHaveLength(1);
    pending.shift()?.reject(new Error('first failure'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await settle();

    const afterErrorBanners = timeline.frames().map(frame => frame.showErrorBanner);
    if (!afterErrorBanners.includes(true)) {
      timeline.unmount();
      throw new Error(`W-ERR-RETRY missing error banner: ${JSON.stringify(timeline.frames())}`);
    }

    void latest.refetch().catch(() => undefined);
    await settle();
    expect(pending).toHaveLength(1);
    pending.shift()?.resolve({ row: { id: 'row-1', groupId: 'g', status: 'active' } });
    await settle();

    const banners = timeline.frames().map(frame => frame.showErrorBanner);
    const flickers = banners.some((banner, index) => banner && banners.slice(index + 1).some((next, nextIndex) => !next && banners.slice(index + nextIndex + 2).includes(true)));

    timeline.unmount();
    if (!banners.includes(true)) {
      throw new Error(`W-ERR-RETRY missing error banner: ${JSON.stringify(timeline.frames())}`);
    }
    if (flickers) {
      throw new Error(`W-ERR-RETRY offending frames: ${JSON.stringify(timeline.frames())}`);
    }
  });

  it('W-SURV does not emit terminal empty after a mounted reader loses its rows', async () => {
    const { pending, transport } = createDeferredQuery();
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows();
    const query = rows.query<Response, ScopeValue, ScopeValue, Row>('loading-survival', {
      document,
      vars: value => value,
      select: data => data.row,
      into: rows.scopes.byGroup
    });
    let latest!: ReturnType<typeof query.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = query.use({ groupId: 'g' });
      return latest.loadingState;
    });

    await settle();
    pending.shift()?.resolve({ row: { id: 'row-1', groupId: 'g', status: 'active' } });
    await settle();
    expect(latest.data).toEqual([{ id: 'row-1', groupId: 'g', status: 'active' }]);

    act(() => {
      rows.destroy('row-1');
    });
    await settle();

    const frames = timeline.frames();
    if (frames.some(frame => frame.showEmptyState)) {
      timeline.unmount();
      throw new Error(`W-SURV offending frames: ${JSON.stringify(frames)}`);
    }
    if (!frames.some(frame => frame.showSkeleton || frame.phase === 'initial_loading')) {
      timeline.unmount();
      throw new Error(`W-SURV missing loading frame: ${JSON.stringify(frames)}`);
    }

    expect(pending).toHaveLength(1);
    pending.shift()?.resolve({ row: { id: 'row-2', groupId: 'g', status: 'active' } });
    await settle();
    const finalFrames = timeline.frames();
    timeline.unmount();
    if (!Array.isArray(latest.data) || latest.data.length !== 1 || finalFrames.at(-1)?.hasData !== true) {
      throw new Error(`W-SURV recovery failed: data=${JSON.stringify(latest.data)}, frames=${JSON.stringify(finalFrames)}, pending=${pending.length}`);
    }
  });

  it('LC6 exposes retry and offline observability during a failed fetch', async () => {
    const { pending, transport } = createDeferredQuery();
    const wasFocused = focusManager.isFocused();
    const wasOnline = onlineManager.isOnline();
    configureDb({
      storage: createMemoryPlane(),
      transport,
      defaults: {
        networkMode: 'always' as never,
        retry: { query: { classify: () => 'network', budgets: { network: 1 }, backoff: { baseMs: 1, maxMs: 1 } } }
      } as never
    });
    const rows = createRows();
    const query = rows.query<Response, ScopeValue, ScopeValue, Row>('loading-observability', {
      document,
      vars: value => value,
      select: data => data.row,
      into: rows.scopes.byGroup
    });
    let latest!: ReturnType<typeof query.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = query.use({ groupId: 'g' });
      return latest.loadingState;
    });

    await settle();
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    pending.shift()?.reject(new Error('retry failure'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    await settle();

    const retryFrames = timeline.frames();
    if (!retryFrames.some(frame => frame.isRetrying && frame.retryAttempt > 0)) {
      timeline.unmount();
      throw new Error(`LC6 missing retry frame: ${JSON.stringify(retryFrames)}`);
    }
    pending.shift()?.resolve({ row: { id: 'row-1', groupId: 'g', status: 'active' } });
    await settle();
    timeline.unmount();

    const normalTransport = createMockTransport({
      query: async <TData,>() => ({ data: { row: { id: 'row-2', groupId: 'g', status: 'active' } } as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport: normalTransport });
    const normalRows = createRows();
    const normalQuery = normalRows.query<Response, ScopeValue, ScopeValue, Row>('loading-observability-normal', {
      document,
      vars: value => value,
      select: data => data.row,
      into: normalRows.scopes.byGroup
    });
    let normalLatest!: ReturnType<typeof normalQuery.use>;
    const normalTimeline = recordTimelineInProvider(() => {
      normalLatest = normalQuery.use({ groupId: 'g' });
      return normalLatest.loadingState;
    });

    await settle();

    const steadyFrame = normalTimeline.frames().at(-1);
    normalTimeline.unmount();
    focusManager.setFocused(wasFocused);
    onlineManager.setOnline(wasOnline);
    expect(steadyFrame).toMatchObject({ isRetrying: false, retryAttempt: 0, isOffline: false });
    // GAP: The public barrel and test harness do not expose a primitive for setting react-query fetchStatus to paused.
  });

  it('W-REFRESH-VOID does not claim to show data while a refetch has zero rows', async () => {
    const { pending, transport } = createDeferredQuery();
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows();
    const query = rows.query<Response, ScopeValue, ScopeValue, Row>('loading-refresh-void', {
      document,
      vars: value => value,
      select: data => data.row,
      into: rows.scopes.byGroup
    });
    let latest!: ReturnType<typeof query.use>;
    const timeline = recordTimelineInProvider(() => {
      latest = query.use({ groupId: 'g' });
      return { data: latest.data, loadingState: latest.loadingState };
    });

    await settle();
    pending.shift()?.resolve({ row: { id: 'row-1', groupId: 'g', status: 'active' } });
    await settle();
    const deathFrameStart = timeline.frames().length;
    act(() => {
      rows.destroy('row-1');
    });
    await settle();

    const frames = timeline.frames().slice(deathFrameStart);
    timeline.unmount();
    if (!frames.some(frame => frame.loadingState.showSkeleton || frame.loadingState.phase === 'initial_loading')) {
      throw new Error(`W-REFRESH-VOID missing loading frame: ${JSON.stringify(frames)}`);
    }
    if (frames.some(frame => frame.loadingState.showData && (Array.isArray(frame.data) ? frame.data.length : frame.data == null ? 0 : 1) === 0)) {
      throw new Error(`W-REFRESH-VOID offending frames: ${JSON.stringify(frames)}`);
    }
  });
});
