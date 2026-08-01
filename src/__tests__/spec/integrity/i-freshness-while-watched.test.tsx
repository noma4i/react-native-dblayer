import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModelRuntime, f } from '../../testApi';
import type { LoadingState } from '../../testApi';
import { createMemoryPlane, createMockTransport, settle } from '../helpers/harness';

type Row = { id: string; name: string };
type Response = { rows: Row[] };

const document = { kind: 'Document', definitions: [] } as never;
const STALE_TIME = 10_000;

const createRows = (id: string) => defineModelRuntime({ id, name: id, fields: { name: f.str() } });

/**
 * Freshness has to mean something while the screen is open. A chat declares a five-minute window
 * precisely so a silently dead socket is repaired; if the window is only consulted when a reader
 * mounts, the repair never happens for the user who stays in the conversation - the exact case the
 * window exists for. Expiry is an event like any other, and the reader watching the data is the one
 * that must act on it.
 */
describe('freshness while the reader watches', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes a mounted reader when its declared freshness expires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', name: `v${++calls}` }] } as TData }) })
    });
    const rows = createRows('FreshnessWhileWatchedRefresh');
    const query = rows.query<Response, void, void, Row>('detail', { document, key: 'freshness-while-watched-refresh', select: data => data.rows, staleTime: STALE_TIME });
    const Reader = () => {
      query.use(undefined);
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    expect(rows.find('row-1')?.name).toBe('v1');

    // The reader never unmounts, the app never backgrounds and the network never drops: expiry is
    // the only thing that happens.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(STALE_TIME + 1_000);
    });
    await settle();

    expect(calls).toBe(2);
    expect(rows.find('row-1')?.name).toBe('v2');
    act(() => root.unmount());
  });

  it('shows the old value for every frame of that refresh, never a skeleton or an empty state', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    let calls = 0;
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ query: async <TData,>() => ({ data: { rows: [{ id: 'row-1', name: `v${++calls}` }] } as TData }) })
    });
    const rows = createRows('FreshnessWhileWatchedFrames');
    const query = rows.query<Response, void, void, Row>('detail', { document, key: 'freshness-while-watched-frames', select: data => data.rows, staleTime: STALE_TIME });
    const frames: Array<{ name: string | undefined; loadingState: LoadingState }> = [];
    const Reader = () => {
      const result = query.use(undefined);
      frames.push({ name: rows.find('row-1')?.name, loadingState: result.loadingState });
      return null;
    };
    let root!: TestRenderer.ReactTestRenderer;

    act(() => {
      root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
    });
    await settle();
    const framesBeforeExpiry = frames.length;

    await act(async () => {
      await jest.advanceTimersByTimeAsync(STALE_TIME + 1_000);
    });
    await settle();

    const refreshFrames = frames.slice(framesBeforeExpiry);
    expect(refreshFrames.length).toBeGreaterThan(0);
    expect(refreshFrames.filter(frame => frame.loadingState.showSkeleton)).toEqual([]);
    expect(refreshFrames.filter(frame => frame.loadingState.showEmptyState)).toEqual([]);
    expect(refreshFrames.filter(frame => frame.name === undefined)).toEqual([]);
    expect(refreshFrames.at(-1)?.name).toBe('v2');
    act(() => root.unmount());
  });
});
