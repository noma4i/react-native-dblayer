import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { diagnostics, renderCounted, setupSpecRuntime } from '../helpers/harness';

type ScopedRow = { id: string; groupId: string; title: string; rank: number; markers: Array<{ id: string }> };
type WindowResult = { rows: ScopedRow[]; totalCount: number; hasMore: boolean; isPreviousData: boolean; fetchNextPage: () => void };

const createRows = () =>
  defineModel({
    id: 'SpecRerenderScopeWindowBudget',
    name: 'SpecRerenderScopeWindowBudget',
    fields: { groupId: f.str(), title: f.str(), rank: f.num(), markers: f.raw<Array<{ id: string }>>() },
    scopes: { byGroup: ({ by: { groupId: 'groupId' }, sort: { field: 'rank', dir: 'asc' } }) }
  });

const seedRows = (rows: ReturnType<typeof createRows>): void => {
  rows.insertMany(
    Array.from({ length: 30 }, (_, index) => ({
      id: `row-${index}`,
      groupId: index < 15 ? 'g1' : 'g2',
      title: `row-${index}`,
      rank: index,
      markers: [{ id: `marker-${index}` }]
    }))
  );
};

const renderWindow = (useWindow: (value: { groupId: string }, options?: { pageSize?: number; keepPrevious?: boolean }) => WindowResult, initialGroupId: string) => {
  let current!: WindowResult;
  let renders = 0;
  let root!: TestRenderer.ReactTestRenderer;
  const Reader = ({ groupId }: { groupId: string }) => {
    current = useWindow({ groupId }, { pageSize: 5, keepPrevious: true });
    renders += 1;
    return null;
  };
  act(() => {
    root = TestRenderer.create(React.createElement(Reader, { groupId: initialGroupId }));
  });
  return {
    result: () => current,
    renders: () => renders,
    update: (groupId: string) => act(() => root.update(React.createElement(Reader, { groupId }))),
    unmount: () => act(() => root.unmount())
  };
};

const idsOf = (rows: ScopedRow[]): string[] => rows.map(row => row.id);

describe('rerender matrix scope window budget', () => {
  it('keeps scope reader byGroup(g1) stable for g2 patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const before = reader.renders();
    act(() => rows.update('row-20', { title: 'updated outside scope' }));
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('rerenders scope reader byGroup(g1) when g1 rank patch reorders', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const before = reader.renders();
    act(() => rows.update('row-0', { rank: 99 }));
    expect(reader.renders() - before).toBe(1);
    expect(reader.result()).toHaveLength(15);
    expect(new Set(idsOf(reader.result()))).toEqual(new Set(Array.from({ length: 15 }, (_, index) => `row-${index}`)));
    expect(idsOf(reader.result()).at(-1)).toBe('row-0');
    reader.unmount();
  });

  it('keeps scope reader byGroup(g1) with renderKeys rank on title patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }, { renderKeys: ['rank'] }));
    const before = reader.renders();
    act(() => rows.update('row-2', { title: 'title-only patch' }));
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('rerenders scope reader byGroup(g1) once for an in-scope title patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const before = reader.renders();
    act(() => rows.update('row-3', { title: 'scope title patch' }));
    expect(reader.renders() - before).toBe(1);
    reader.unmount();
  });

  it('keeps scope useFirst stable for an out-of-scope patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.useFirst({ groupId: 'g1' }));
    const initial = reader.result();
    const before = reader.renders();
    act(() => rows.update('row-20', { title: 'out-of-scope first patch' }));
    expect(reader.result()).toBe(initial);
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('preserves unaffected scope row identities after an in-scope patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const initial = reader.result();
    act(() => rows.update('row-3', { title: 'identity patch' }));
    expect(reader.result().map((row, index) => row === initial[index])).toEqual(initial.map((_, index) => index !== 3));
    reader.unmount();
  });

  it('keeps scope rows stable when an unrelated model writes', () => {
    setupSpecRuntime();
    const rows = createRows();
    const unrelated = defineModel({ id: 'SpecRerenderScopeWindowUnrelated', name: 'SpecRerenderScopeWindowUnrelated', fields: { value: f.str() } });
    seedRows(rows);
    unrelated.insert({ id: 'one', value: 'before' });
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const initial = reader.result();
    act(() => unrelated.update('one', { value: 'after' }));
    expect(reader.result()).toBe(initial);
    reader.unmount();
  });

  it('does not rerender an unchanged scope order after a complete reconcile', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const initial = reader.result();
    const before = reader.renders();

    act(() => {
      rows.scopes.byGroup.seed(
        { groupId: 'g1' },
        initial.map(row => ({ ...row }))
      );
    });

    expect(reader.result()).toBe(initial);
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  // The resort counter is the only observable effect of the scope-order equality guard: a rebuild runs either
  // way, so an unguarded order revision does not cost work - it makes `scopeReadResorts` report work that never
  // happened. Work counters are the sole admissible basis for a speed gate, so a counter that overreports is
  // worse than no counter. Both halves live in one test on purpose: asserting zero is only meaningful next to a
  // proof that this same harness can drive the counter above zero.
  it('counts a resort only when a complete reconcile actually changes the scope order', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const initial = reader.result();

    diagnostics().reset();
    act(() => {
      rows.scopes.byGroup.seed(
        { groupId: 'g1' },
        initial.map(row => ({ ...row }))
      );
    });
    const unchanged = diagnostics().snapshot();

    diagnostics().reset();
    act(() => {
      rows.scopes.byGroup.seed(
        { groupId: 'g1' },
        initial.map((row, index) => ({ ...row, rank: initial.length - index }))
      );
    });
    const reordered = diagnostics().snapshot();

    expect(unchanged.scopeReadPasses).toBeGreaterThan(0);
    expect(unchanged.scopeReadResorts).toBe(0);
    expect(reordered.scopeReadResorts).toBeGreaterThan(0);
    reader.unmount();
  });

  // A shuffled payload of UNCHANGED rows exercises the planner's canonicalization alone: no field
  // changed, so no reposition pass runs, and only the plan-time sort keeps the scope order canonical.
  it('keeps the canonical sorted order when a complete payload arrives shuffled', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }));
    const initial = reader.result();
    expect(initial.map(row => row.rank)).toEqual([...initial.map(row => row.rank)].sort((a, b) => a - b));

    diagnostics().reset();
    act(() => {
      rows.scopes.byGroup.seed(
        { groupId: 'g1' },
        [...initial].reverse().map(row => ({ ...row }))
      );
    });

    expect(reader.result().map(row => row.id)).toEqual(initial.map(row => row.id));
    expect(diagnostics().snapshot().scopeReadResorts).toBe(0);
    reader.unmount();
  });

  it('preserves selected row identities across a fresh scope snapshot', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }, { select: row => ({ id: row.id, payload: { ...row } }) }));
    const initial = reader.result();

    act(() => {
      rows.scopes.byGroup.seed(
        { groupId: 'g1' },
        rows.scopes.byGroup.read({ groupId: 'g1' }).map(row => ({ ...row }))
      );
    });

    expect(reader.result()).toBe(initial);
    reader.unmount();
  });

  it('keeps a row render key stable when an array is rewritten with the same element references', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const markers = rows.find('row-2')!.markers;
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }, { renderKeys: ['markers'] }));
    const beforeRow = reader.result()[2];
    const before = reader.renders();
    act(() => rows.update('row-2', { markers: [...markers] }));
    expect(reader.result()[2]).toBe(beforeRow);
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('rerenders useWindow(g1, pageSize: 5) for in-window patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderWindow(rows.scopes.byGroup.useWindow as never, 'g1');
    const before = reader.renders();
    act(() => rows.update('row-1', { title: 'in-window changed' }));
    expect(reader.renders() - before).toBe(1);
    expect(idsOf(reader.result().rows)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    reader.unmount();
  });

  it('preserves unaffected useWindow row identities for an in-window patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderWindow(rows.scopes.byGroup.useWindow as never, 'g1');
    const initial = reader.result().rows;
    act(() => rows.update('row-1', { title: 'window identity patch' }));
    expect(reader.result().rows.map((row, index) => row === initial[index])).toEqual([true, false, true, true, true]);
    reader.unmount();
  });

  it('keeps useWindow(g1, pageSize: 5) stable for off-window patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderWindow(rows.scopes.byGroup.useWindow as never, 'g1');
    const before = reader.renders();
    act(() => rows.update('row-12', { title: 'off-window changed' }));
    expect(reader.renders() - before).toBe(0);
    expect(idsOf(reader.result().rows)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    reader.unmount();
  });

  it('moves useWindow(g1, pageSize: 5) by local page growth', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderWindow(rows.scopes.byGroup.useWindow as never, 'g1');
    const before = reader.renders();
    act(() => reader.result().fetchNextPage());
    expect(reader.renders() - before).toBe(1);
    expect(reader.result().rows).toHaveLength(10);
    reader.unmount();
  });

  it('rerenders useWindow(g1) once for off-window destroy totalCount', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderWindow(rows.scopes.byGroup.useWindow as never, 'g1');
    const before = reader.renders();
    act(() => rows.destroy('row-12'));
    expect(reader.renders() - before).toBe(1);
    expect(idsOf(reader.result().rows)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    expect(reader.result().totalCount).toBe(14);
    expect(reader.result().hasMore).toBe(true);
    reader.unmount();
  });

  it('counts window updates from useWindow(g1).totalCount as object-change coupling', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.useWindow({ groupId: 'g1' }).totalCount);
    const before = reader.result();
    const renders = reader.renders();
    act(() => rows.update('row-1', { title: 'total count visibility' }));
    expect(reader.result()).toBe(before);
    expect(reader.renders() - renders).toBe(1);
    expect(reader.result()).toBe(15);
    reader.unmount();
  });

  it('keeps retained g1 window while switching to empty g3 and freezes retained patch', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderWindow(rows.scopes.byGroup.useWindow as never, 'g1');
    reader.update('g3');
    expect(idsOf(reader.result().rows)).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    expect(reader.result().isPreviousData).toBe(true);
    const before = reader.renders();
    act(() => rows.update('row-0', { title: 'retained source patch' }));
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });

  it('rerenders count reader when g1 membership changes', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }).length);
    const before = reader.renders();
    act(() => rows.update('row-0', { groupId: 'g2' }));
    expect(reader.result()).toBe(14);
    expect(reader.renders() - before).toBe(1);
    reader.unmount();
  });

  it('rerenders scope useFirst when a rank patch changes the first row', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.useFirst({ groupId: 'g1' }));
    const before = reader.renders();
    act(() => rows.update('row-1', { rank: -1 }));
    expect(reader.result()?.id).toBe('row-1');
    expect(reader.renders() - before).toBe(1);
    reader.unmount();
  });

  it('keeps g1 count reader stable for g2 changes', () => {
    setupSpecRuntime();
    const rows = createRows();
    seedRows(rows);
    const reader = renderCounted(() => rows.scopes.byGroup.use({ groupId: 'g1' }).length);
    const before = reader.renders();
    act(() => rows.update('row-20', { title: 'g2 title-only' }));
    expect(reader.renders() - before).toBe(0);
    reader.unmount();
  });
});
