import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useMemo } from 'react';
import { devClearAllDataAndState, useJoinedEntities, useOrderedEntities, useStableEntity, useStableItems, useStableSorted, useWindowedLoadMore } from '../index';
import { useStableArray } from '../queries/base/shared';
import { createTodoModel, installMemoryStorage } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

type HookResult<TProps, TResult> = {
  current: TResult;
  rerender: (props: TProps) => void;
  unmount: () => void;
};

const renderHook = <TProps, TResult>(read: (props: TProps) => TResult, initialProps: TProps): HookResult<TProps, TResult> => {
  let current!: TResult;
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = ({ props }: { props: TProps }) => {
    current = read(props);
    return null;
  };

  act(() => {
    renderer = TestRenderer.create(<Harness props={initialProps} />);
  });

  return {
    get current() {
      return current;
    },
    rerender(props: TProps) {
      act(() => {
        renderer.update(<Harness props={props} />);
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    }
  };
};

type SourceRow = {
  id: string;
  title: string;
  count: number;
  hiddenLabel: string;
};

type ViewItem = {
  id: string;
  label: string;
  count: number;
  hiddenLabel: string;
};

type ViewEntry = {
  sectionId: string;
  item: ViewItem;
};

const EMPTY_ITEMS: ViewItem[] = [];

describe('stable view hooks', () => {
  afterEach(async () => {
    await flush();
    devClearAllDataAndState();
  });

  it('preserves item and array identity across unchanged projection emissions', () => {
    const rows: SourceRow[] = [
      { id: '1', title: 'One', count: 1, hiddenLabel: 'a' },
      { id: '2', title: 'Two', count: 2, hiddenLabel: 'a' }
    ];

    const hook = renderHook(
      (props: { rows: SourceRow[]; sectionId: string }) =>
        useStableItems<SourceRow, ViewEntry, ViewItem>(props.rows, {
          getKey: row => row.id,
          buildEntry: (row: SourceRow) => ({
            sectionId: props.sectionId,
            item: { id: row.id, label: row.title, count: row.count, hiddenLabel: row.hiddenLabel }
          }),
          entriesEqual: (prev, next) =>
            prev.sectionId === next.sectionId && prev.item.id === next.item.id && prev.item.label === next.item.label && prev.item.count === next.item.count,
          emptyItems: EMPTY_ITEMS
        }),
      { rows, sectionId: 'main' }
    );

    const firstItems = hook.current;
    const firstItem = firstItems[0]!;
    const secondItem = firstItems[1]!;

    hook.rerender({
      rows: [
        { id: '1', title: 'One', count: 1, hiddenLabel: 'b' },
        { id: '2', title: 'Two', count: 2, hiddenLabel: 'b' }
      ],
      sectionId: 'main'
    });

    expect(hook.current).toBe(firstItems);
    expect(hook.current[0]).toBe(firstItem);
    expect(hook.current[1]).toBe(secondItem);

    hook.rerender({
      rows: [
        { id: '1', title: 'One', count: 1, hiddenLabel: 'c' },
        { id: '2', title: 'Changed', count: 2, hiddenLabel: 'c' }
      ],
      sectionId: 'main'
    });

    expect(hook.current).not.toBe(firstItems);
    expect(hook.current[0]).toBe(firstItem);
    expect(hook.current[1]).not.toBe(secondItem);
    expect(hook.current[1]?.label).toBe('Changed');

    hook.unmount();
  });

  it('returns a stable empty instance for empty and all-skipped projections', () => {
    const hook = renderHook(
      (rows: SourceRow[]) =>
        useStableItems<SourceRow, ViewEntry, ViewItem>(rows, {
          getKey: row => row.id,
          buildEntry: () => null,
          entriesEqual: () => true,
          emptyItems: EMPTY_ITEMS
        }),
      [] as SourceRow[]
    );

    expect(hook.current).toBe(EMPTY_ITEMS);

    hook.rerender([{ id: '1', title: 'One', count: 1, hiddenLabel: 'a' }]);

    expect(hook.current).toBe(EMPTY_ITEMS);

    hook.rerender([]);

    expect(hook.current).toBe(EMPTY_ITEMS);

    hook.unmount();
  });

  it('uses renderKeys to compare item fields without a custom entriesEqual callback', () => {
    const rows: SourceRow[] = [{ id: '1', title: 'One', count: 1, hiddenLabel: 'a' }];

    const hook = renderHook(
      (props: { rows: SourceRow[] }) =>
        useStableItems(props.rows, {
          getKey: row => row.id,
          buildEntry: (row: SourceRow) => ({
            item: { id: row.id, label: row.title, count: row.count, hiddenLabel: row.hiddenLabel }
          }),
          renderKeys: ['id', 'label', 'count'],
          emptyItems: EMPTY_ITEMS
        }),
      { rows }
    );

    const firstItems = hook.current;
    const firstItem = firstItems[0]!;

    hook.rerender({ rows: [{ id: '1', title: 'One', count: 1, hiddenLabel: 'b' }] });

    expect(hook.current).toBe(firstItems);
    expect(hook.current[0]).toBe(firstItem);

    hook.rerender({ rows: [{ id: '1', title: 'One', count: 2, hiddenLabel: 'b' }] });

    expect(hook.current).not.toBe(firstItems);
    expect(hook.current[0]).not.toBe(firstItem);
    expect(hook.current[0]?.count).toBe(2);

    hook.unmount();
  });

  it('uses default item projection options and keeps explicit options authoritative', () => {
    const rows: SourceRow[] = [{ id: '1', title: 'One', count: 1, hiddenLabel: 'a' }];

    const defaultsHook = renderHook((items: SourceRow[]) => useStableItems(items, { renderKeys: ['id', 'title', 'count'] }), rows);
    const defaultItems = defaultsHook.current;
    const defaultItem = defaultItems[0]!;

    defaultsHook.rerender([{ id: '1', title: 'One', count: 1, hiddenLabel: 'b' }]);

    expect(defaultsHook.current).toBe(defaultItems);
    expect(defaultsHook.current[0]).toBe(defaultItem);

    defaultsHook.rerender([{ id: '1', title: 'Changed', count: 1, hiddenLabel: 'b' }]);

    expect(defaultsHook.current).not.toBe(defaultItems);
    expect(defaultsHook.current[0]?.title).toBe('Changed');

    defaultsHook.unmount();

    const explicitEmpty: ViewItem[] = [];
    const explicitHook = renderHook(
      (items: SourceRow[]) =>
        useStableItems<SourceRow, ViewEntry, ViewItem>(items, {
          getKey: row => `scope:${row.id}`,
          buildEntry: row => ({
            sectionId: 'explicit',
            item: { id: `view:${row.id}`, label: row.title, count: row.count, hiddenLabel: row.hiddenLabel }
          }),
          renderKeys: ['id', 'label', 'count'],
          emptyItems: explicitEmpty
        }),
      rows
    );

    expect(explicitHook.current[0]?.id).toBe('view:1');
    explicitHook.rerender([]);
    expect(explicitHook.current).toBe(explicitEmpty);

    explicitHook.unmount();
  });

  it('throws when default item keys are requested for sources without string ids', () => {
    const defaultKeyRequiresStringId = () => {
      // @ts-expect-error default getKey requires source.id to be a string
      useStableItems([{ id: 1, label: 'One' }], { renderKeys: ['label'] });
    };
    void defaultKeyRequiresStringId;

    expect(() =>
      renderHook(
        (items: Array<{ id: string; label: string }>) => useStableItems(items, { renderKeys: ['label'] }),
        [{ id: 1, label: 'One' }] as unknown as Array<{ id: string; label: string }>
      )
    ).toThrow('useStableItems default getKey requires source items with a string id.');
  });

  it('keeps one entity stable with volatileKeys while rendered fields remain equal', () => {
    const first = { id: '1', title: 'One', updatedAt: '2026-01-01T00:00:00.000Z' };
    const hook = renderHook((value: typeof first) => useStableEntity(value, { volatileKeys: ['updatedAt'] }), first);
    const stable = hook.current;

    hook.rerender({ id: '1', title: 'One', updatedAt: '2026-01-01T00:00:01.000Z' });

    expect(hook.current).toBe(stable);

    hook.rerender({ id: '1', title: 'Changed', updatedAt: '2026-01-01T00:00:02.000Z' });

    expect(hook.current).not.toBe(stable);
    expect(hook.current?.title).toBe('Changed');

    hook.unmount();
  });

  it('keeps one entity stable with renderKeys and resets across nullish transitions', () => {
    type StableUser = { id: string; name: string; presence: string };
    const hook = renderHook((value: StableUser | null | undefined) => useStableEntity(value, { renderKeys: ['id', 'name'] }), null as StableUser | null | undefined);

    expect(hook.current).toBeNull();

    const first = { id: '1', name: 'Ada', presence: 'offline' };
    hook.rerender(first);
    const stable = hook.current;

    hook.rerender({ id: '1', name: 'Ada', presence: 'online' });

    expect(hook.current).toBe(stable);

    hook.rerender(undefined);
    expect(hook.current).toBeUndefined();

    const appearedAgain = { id: '1', name: 'Ada', presence: 'online' };
    hook.rerender(appearedAgain);

    expect(hook.current).toBe(appearedAgain);
    expect(hook.current).not.toBe(stable);

    hook.unmount();
  });

  it('reuses sorted output for element-identical input and invalidates on real change or extra key change', () => {
    type SortItem = { id: string; rank: number };
    const low: SortItem = { id: 'low', rank: 1 };
    const high: SortItem = { id: 'high', rank: 2 };

    const hook = renderHook(
      (props: { items: SortItem[]; descending: boolean }) =>
        useStableSorted(props.items, (left, right) => (props.descending ? right.rank - left.rank : left.rank - right.rank), props.descending),
      { items: [high, low], descending: false }
    );

    const ascending = hook.current;
    expect(ascending.map(item => item.id)).toEqual(['low', 'high']);

    hook.rerender({ items: [high, low], descending: false });

    expect(hook.current).toBe(ascending);

    const changedLow: SortItem = { id: 'low', rank: 3 };
    hook.rerender({ items: [high, changedLow], descending: false });

    const changed = hook.current;
    expect(changed).not.toBe(ascending);
    expect(changed.map(item => item.id)).toEqual(['high', 'low']);

    hook.rerender({ items: [high, changedLow], descending: true });

    expect(hook.current).not.toBe(changed);
    expect(hook.current.map(item => item.id)).toEqual(['low', 'high']);

    hook.unmount();
  });

  it('reuses array identity when the next array contains the same element references', () => {
    const first = { id: '1' };
    const second = { id: '2' };

    const hook = renderHook((items: Array<{ id: string }>) => useStableArray(items), [first, second]);
    const firstArray = hook.current;

    hook.rerender([first, second]);

    expect(hook.current).toBe(firstArray);

    hook.rerender([first, { id: '2' }]);

    expect(hook.current).not.toBe(firstArray);

    hook.unmount();
  });

  it('can be composed with memoized source projections', () => {
    const hook = renderHook(
      (rows: SourceRow[]) => {
        const ids = useMemo(() => rows.map(row => row.id), [rows]);
        return useStableArray(ids);
      },
      [{ id: '1', title: 'One', count: 1, hiddenLabel: 'a' }]
    );
    const firstIds = hook.current;

    hook.rerender([{ id: '1', title: 'One', count: 1, hiddenLabel: 'b' }]);

    expect(hook.current).toBe(firstIds);

    hook.unmount();
  });

  it('returns ordered entities, drops missing ids, and keeps a shared empty array', () => {
    const model = {
      byIds: (ids: string[]) =>
        [
          { id: '1', label: 'One' },
          { id: '2', label: 'Two' }
        ].filter(item => ids.includes(item.id))
    };

    const hook = renderHook((ids: string[]) => useOrderedEntities(model, ids), [] as string[]);
    const empty = hook.current;

    expect(empty).toEqual([]);

    hook.rerender(['2', 'missing', '1']);

    expect(hook.current.map(item => item.id)).toEqual(['2', '1']);

    hook.rerender(['missing']);

    expect(hook.current).toBe(empty);

    hook.rerender([]);

    expect(hook.current).toBe(empty);

    hook.unmount();
  });

  it('hydrates join rows in join order, drops missing entities, and reflects model updates', async () => {
    installMemoryStorage();
    const model = createTodoModel();

    act(() => {
      model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
      model.insertStored({ id: '2', title: 'Two', listId: 'a', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
      model.insertStored({ id: '3', title: 'Three', listId: 'a', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    });

    type JoinRow = { todoId: string | number; badge: string; hiddenLabel: string };
    type JoinedItem = { id: string; label: string; done: boolean; badge: string; hiddenLabel: string };

    const hook = renderHook(
      (rows: JoinRow[]) =>
        useJoinedEntities(rows, {
          idField: 'todoId',
          model,
          renderKeys: ['id', 'label', 'done', 'badge'],
          map: (join, entity): JoinedItem => ({
            id: entity.id,
            label: entity.title,
            done: entity.done,
            badge: join.badge,
            hiddenLabel: join.hiddenLabel
          })
        }),
      [
        { todoId: '2', badge: 'second', hiddenLabel: 'a' },
        { todoId: 'missing', badge: 'missing', hiddenLabel: 'a' },
        { todoId: 1, badge: 'first', hiddenLabel: 'a' }
      ]
    );

    await act(async () => {
      await flush();
    });

    expect(hook.current.map(item => item.id)).toEqual(['2', '1']);
    expect(hook.current.map(item => item.badge)).toEqual(['second', 'first']);

    const firstItems = hook.current;
    const stableSecond = hook.current[1]!;

    hook.rerender([
      { todoId: '2', badge: 'second', hiddenLabel: 'b' },
      { todoId: 'missing', badge: 'missing', hiddenLabel: 'b' },
      { todoId: 1, badge: 'first', hiddenLabel: 'b' }
    ]);

    expect(hook.current).toBe(firstItems);
    expect(hook.current[1]).toBe(stableSecond);

    act(() => {
      model.patch('2', { title: 'Two updated', updatedAt: '2026-01-02T00:00:00.000Z' });
    });

    await act(async () => {
      await flush();
    });

    expect(hook.current.map(item => item.label)).toEqual(['Two updated', 'One']);
    expect(hook.current[1]).toBe(stableSecond);

    hook.unmount();
  });

  it('returns shared empty output for nullish join rows and keeps hook order stable across flips', async () => {
    installMemoryStorage();
    const model = createTodoModel();

    act(() => {
      model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    });

    type JoinRow = { todoId: string };

    const hook = renderHook(
      (rows: readonly JoinRow[] | null | undefined) =>
        useJoinedEntities(rows, {
          idField: 'todoId',
          model,
          renderKeys: ['id', 'title', 'done']
        }),
      null as readonly JoinRow[] | null | undefined
    );

    const empty = hook.current;
    expect(empty).toEqual([]);

    hook.rerender([]);
    expect(hook.current).toBe(empty);

    hook.rerender([{ todoId: '1' }]);

    await act(async () => {
      await flush();
    });

    expect(hook.current.map(item => item.id)).toEqual(['1']);
    expect(hook.current[0]?.title).toBe('One');

    hook.rerender(null);
    expect(hook.current).toBe(empty);

    hook.unmount();
  });

  it('windows rendered load-more state and resets on refresh or reset key change', async () => {
    const loadMore = jest.fn();
    const refresh = jest.fn(async () => {});

    const hook = renderHook(
      (props: { pageSize: number; resetKey: string }) => useWindowedLoadMore(loadMore, refresh, props.pageSize, props.resetKey),
      { pageSize: 20, resetKey: 'all' }
    );

    expect(hook.current.windowSize).toBe(20);

    act(() => {
      hook.current.loadMore();
    });

    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(hook.current.windowSize).toBe(40);

    await act(async () => {
      await hook.current.refresh();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(hook.current.windowSize).toBe(20);

    act(() => {
      hook.current.loadMore();
    });

    expect(hook.current.windowSize).toBe(40);

    hook.rerender({ pageSize: 20, resetKey: 'premium' });

    expect(hook.current.windowSize).toBe(20);

    hook.unmount();
  });
});
