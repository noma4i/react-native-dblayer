import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { configureDb, defineModel, f, resetRuntime, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;

const createMoments = (id: string) =>
  defineModel({
    id,
    name: id,
    fields: { vibeId: f.str(), label: f.str() },
    scopes: { feed: scope<{ id: string; vibeId: string; label: string }>({ by: { vibeId: 'vibeId' }, sort: 'server-order' }) }
  });

type Moments = ReturnType<typeof createMoments>;
type Moment = NonNullable<ReturnType<Moments['get']>>;
type WindowResult<T> = { rows: T[]; totalCount: number; hasMore: boolean; isPreviousData: boolean; fetchNextPage: () => void };
type KeepWindow<T> = (value: { vibeId: string }, options?: { pageSize?: number; keepPrevious?: boolean }) => WindowResult<T>;
type KeepRows<T> = (value: { vibeId: string }, options?: { keepPrevious?: boolean }) => T[];

const insertMoment = (moments: Moments, id: string, vibeId: string, label = id) => moments.insertStored({ id, vibeId, label });

const renderWindow = <T,>(useWindow: KeepWindow<T>, initialVibeId: string, keepPrevious = true) => {
  let current!: WindowResult<T>;
  let renders = 0;
  const history: Array<{ rows: T[]; isPreviousData: boolean }> = [];
  let root!: TestRenderer.ReactTestRenderer;
  const Reader = ({ vibeId, tick = 0 }: { vibeId: string; tick?: number }) => {
    void tick;
    current = useWindow({ vibeId }, { pageSize: 10, keepPrevious });
    renders += 1;
    history.push({ rows: current.rows, isPreviousData: current.isPreviousData });
    return null;
  };
  act(() => {
    root = TestRenderer.create(React.createElement(Reader, { vibeId: initialVibeId }));
  });
  return {
    result: () => current,
    renders: () => renders,
    history,
    update: (vibeId: string, tick = 0) => act(() => root.update(React.createElement(Reader, { vibeId, tick }))),
    unmount: () => act(() => root.unmount())
  };
};

const idsOf = (rows: Array<{ id: string }>): string[] => rows.map(row => row.id);

describe('keep previous scope handoff', () => {
  // Performance scale guarantee: N/A because retention reads and writes one hook-local snapshot reference.
  it('keeps the previous window until the new key produces rows without an empty flash', () => {
    setupSpecRuntime();
    const moments = createMoments('SpecKeepPreviousHandoff');
    insertMoment(moments, 'a-1', 'A');
    const reader = renderWindow(moments.scopes.feed.useWindow as unknown as KeepWindow<Moment>, 'A');

    reader.update('B');
    expect(idsOf(reader.result().rows)).toEqual(['a-1']);
    expect(reader.result().isPreviousData).toBe(true);
    const beforeData = reader.renders();
    act(() => insertMoment(moments, 'b-1', 'B'));

    expect(reader.renders() - beforeData).toBe(1);
    expect(idsOf(reader.result().rows)).toEqual(['b-1']);
    expect(reader.result().isPreviousData).toBe(false);
    expect(reader.history.some(snapshot => snapshot.rows.length === 0)).toBe(false);
    reader.unmount();
  });

  it('releases previous rows when the new key resolves empty', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { rows: [] } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('SpecKeepPreviousEmpty');
    const query = moments.query<{ rows: Moment[] }, { vibeId: string }, { vibeId: string }, Moment>('empty', {
      document,
      key: 'spec-keep-previous-empty',
      vars: value => value,
      select: data => data.rows,
      into: moments.scopes.feed,
      coverage: 'complete'
    });
    insertMoment(moments, 'a-1', 'A');
    const reader = renderWindow(moments.scopes.feed.useWindow as unknown as KeepWindow<Moment>, 'A');

    reader.update('C');
    expect(reader.result().isPreviousData).toBe(true);
    await act(async () => query.fetch({ vibeId: 'C' }));

    expect(reader.result().rows).toEqual([]);
    expect(reader.result().isPreviousData).toBe(false);
    reader.unmount();
  });

  it('defaults to showing the new key empty immediately', () => {
    setupSpecRuntime();
    const moments = createMoments('SpecKeepPreviousDefault');
    insertMoment(moments, 'a-1', 'A');
    const reader = renderWindow(moments.scopes.feed.useWindow as unknown as KeepWindow<Moment>, 'A', false);

    reader.update('B');

    expect(reader.result().rows).toEqual([]);
    expect(reader.result().isPreviousData).toBe(false);
    reader.unmount();
  });

  it('does not leak foreign updates and returns a populated key immediately', () => {
    setupSpecRuntime();
    const moments = createMoments('SpecKeepPreviousView');
    insertMoment(moments, 'a-1', 'A', 'A before');
    insertMoment(moments, 'b-1', 'B', 'B row');
    const view = moments.view<{ id: string; label: string }>('feed', { source: 'feed', include: {}, select: row => ({ id: row.id, label: row.label as string }) });
    const reader = renderWindow(view.useWindow as unknown as KeepWindow<{ id: string; label: string }>, 'A');

    reader.update('B');
    expect(idsOf(reader.result().rows)).toEqual(['b-1']);
    expect(reader.result().isPreviousData).toBe(false);
    const beforePatch = reader.renders();
    act(() => moments.patch('a-1', { label: 'A after' }));
    expect(reader.renders() - beforePatch).toBe(0);
    expect(idsOf(reader.result().rows)).toEqual(['b-1']);
    reader.update('A');
    expect(reader.result().rows).toEqual([{ id: 'a-1', label: 'A after' }]);
    expect(reader.result().isPreviousData).toBe(false);
    reader.unmount();
  });

  it('clears retained rows across runtime reset and remount', () => {
    setupSpecRuntime();
    const moments = createMoments('SpecKeepPreviousReset');
    insertMoment(moments, 'a-1', 'A');
    const useWindow = moments.scopes.feed.useWindow as unknown as KeepWindow<Moment>;
    const reader = renderWindow(useWindow, 'A');
    reader.update('B');
    expect(reader.result().isPreviousData).toBe(true);

    act(() => resetRuntime());
    reader.unmount();
    const fresh = renderWindow(useWindow, 'B');

    expect(fresh.result().rows).toEqual([]);
    expect(fresh.result().isPreviousData).toBe(false);
    fresh.unmount();
  });

  it('drops retention state and subscriptions on unmount', () => {
    setupSpecRuntime();
    const moments = createMoments('SpecKeepPreviousTeardown');
    insertMoment(moments, 'a-1', 'A');
    const reader = renderWindow(moments.scopes.feed.useWindow as unknown as KeepWindow<Moment>, 'A');
    reader.update('B');
    const renders = reader.renders();
    reader.unmount();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    act(() => insertMoment(moments, 'b-1', 'B'));

    expect(reader.renders()).toBe(renders);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('keeps the retained plain-use array stable across unrelated rerenders', () => {
    setupSpecRuntime();
    const moments = createMoments('SpecKeepPreviousIdentity');
    insertMoment(moments, 'a-1', 'A');
    const useRows = moments.scopes.feed.use as unknown as KeepRows<Moment>;
    let rows: Moment[] = [];
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = ({ vibeId, tick }: { vibeId: string; tick: number }) => {
      void tick;
      rows = useRows({ vibeId }, { keepPrevious: true });
      return null;
    };
    act(() => {
      root = TestRenderer.create(React.createElement(Reader, { vibeId: 'A', tick: 0 }));
    });
    act(() => root.update(React.createElement(Reader, { vibeId: 'B', tick: 0 })));
    const retained = rows;
    act(() => root.update(React.createElement(Reader, { vibeId: 'B', tick: 1 })));

    expect(rows).toBe(retained);
    act(() => root.unmount());
  });

  it('ignores a stale old-key response after switching to a populated new key', async () => {
    let resolveOld!: (value: { data: { rows: Moment[] } }) => void;
    const transport = createMockTransport({
      query: <TData,>() =>
        new Promise<{ data: TData }>(resolve => {
          resolveOld = resolve as never;
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('SpecKeepPreviousRace');
    insertMoment(moments, 'a-1', 'A');
    insertMoment(moments, 'b-1', 'B');
    const query = moments.query<{ rows: Moment[] }, { vibeId: string }, { vibeId: string }, Moment>('race', {
      document,
      key: 'spec-keep-previous-race',
      vars: value => value,
      select: data => data.rows,
      into: moments.scopes.feed,
      coverage: 'complete'
    });
    const pending = query.fetch({ vibeId: 'A' });
    const reader = renderWindow(moments.scopes.feed.useWindow as unknown as KeepWindow<Moment>, 'A');
    reader.update('B');
    const renders = reader.renders();

    resolveOld({ data: { rows: [{ id: 'a-stale', vibeId: 'A', label: 'Stale A' }] } });
    await act(async () => pending);

    expect(idsOf(reader.result().rows)).toEqual(['b-1']);
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });
});
