import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useStableEntity, useStableSorted } from '../index';
import { useStableItems } from '../queries/base/shared';

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

});
