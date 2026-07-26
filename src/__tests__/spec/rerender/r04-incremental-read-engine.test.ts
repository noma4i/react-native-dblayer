import { createModelReadEngine } from '../../../read/incrementalReadEngine';

type TestRow = { id: string; rank: number; label: string; visible: boolean };

describe('incremental model read engine', () => {
  it('applies a 100-row delta without rebuilding and matches a full rebuild result', () => {
    const rows = new Map(
      Array.from({ length: 200 }, (_, index) => {
        const id = `row-${index}`;
        return [id, { id, rank: index, label: `initial-${index}`, visible: true } satisfies TestRow];
      })
    );
    let incrementalInitialCalls = 0;
    let rebuildInitialCalls = 0;
    const incremental = createModelReadEngine<TestRow, TestRow[]>({
      signature: 'incremental-large-delta',
      model: 'TestRow',
      where: row => row.visible,
      options: { orderBy: [{ field: 'rank', direction: 'asc' }] },
      initial: () => {
        incrementalInitialCalls += 1;
        return [...rows.values()];
      },
      read: id => rows.get(id),
      select: value => value
    });
    const rebuilt = createModelReadEngine<TestRow, TestRow[]>({
      signature: 'rebuild-large-delta',
      model: 'TestRow',
      where: row => row.visible,
      options: { orderBy: [{ field: 'rank', direction: 'asc' }] },
      initial: () => {
        rebuildInitialCalls += 1;
        return [...rows.values()];
      },
      read: id => rows.get(id),
      select: value => value
    });
    const changes = Array.from({ length: 120 }, (_, index) => {
      const id = `row-${index}`;
      rows.set(id, { id, rank: index, label: `updated-${index}`, visible: true });
      return { model: 'TestRow', id, fields: ['label'] };
    });

    incremental.apply({ rows: changes, scopes: [], mode: 'delta' });
    rebuilt.apply({ rows: changes, scopes: [], mode: 'bulk' });

    expect(incrementalInitialCalls).toBe(1);
    expect(rebuildInitialCalls).toBe(2);
    expect(incremental.value).toEqual(rebuilt.value);
  });

  it('rebuilds for replace and bulk batches', () => {
    const rows = new Map<string, TestRow>([['row-1', { id: 'row-1', rank: 1, label: 'one', visible: true }]]);
    let initialCalls = 0;
    const engine = createModelReadEngine<TestRow, TestRow[]>({
      signature: 'incremental-rebuild-modes',
      model: 'TestRow',
      where: row => row.visible,
      initial: () => {
        initialCalls += 1;
        return [...rows.values()];
      },
      read: id => rows.get(id),
      select: value => value
    });

    engine.apply({ rows: [{ model: 'TestRow', id: 'row-1', fields: ['label'] }], scopes: [], mode: 'replace' });
    engine.apply({ rows: [{ model: 'TestRow', id: 'row-1', fields: ['label'] }], scopes: [], mode: 'bulk' });

    expect(initialCalls).toBe(3);
  });

  it('updates in-place non-order rows without changing their order and preserves equal projections', () => {
    const rows = new Map<string, TestRow>([
      ['row-1', { id: 'row-1', rank: 1, label: 'one', visible: true }],
      ['row-2', { id: 'row-2', rank: 2, label: 'two', visible: true }]
    ]);
    const engine = createModelReadEngine<TestRow, TestRow[]>({
      signature: 'incremental-non-order',
      model: 'TestRow',
      where: row => row.visible,
      options: { orderBy: [{ field: 'rank', direction: 'asc' }] },
      initial: () => [...rows.values()],
      read: id => rows.get(id),
      select: value => value
    });
    const projected = createModelReadEngine<TestRow, number[]>({
      signature: 'incremental-non-order-projection',
      model: 'TestRow',
      where: row => row.visible,
      options: { orderBy: [{ field: 'rank', direction: 'asc' }] },
      initial: () => [...rows.values()],
      read: id => rows.get(id),
      select: value => value.map(row => row.rank)
    });
    const before = engine.value;
    const beforeVersion = engine.version;
    const projectedBefore = projected.value;
    const projectedVersion = projected.version;
    rows.set('row-1', { id: 'row-1', rank: 1, label: 'updated', visible: true });

    engine.apply({ rows: [{ model: 'TestRow', id: 'row-1', fields: ['label'] }], scopes: [], mode: 'delta' });
    projected.apply({ rows: [{ model: 'TestRow', id: 'row-1', fields: ['label'] }], scopes: [], mode: 'delta' });

    expect(engine.value.map(row => row.id)).toEqual(['row-1', 'row-2']);
    expect(engine.value).not.toBe(before);
    expect(engine.value[0]).not.toBe(before[0]);
    expect(engine.version).toBe(beforeVersion + 1);
    expect(projected.value).toBe(projectedBefore);
    expect(projected.version).toBe(projectedVersion);
  });

  it('resorts an in-place update to an order field', () => {
    const rows = new Map<string, TestRow>([
      ['row-1', { id: 'row-1', rank: 1, label: 'one', visible: true }],
      ['row-2', { id: 'row-2', rank: 2, label: 'two', visible: true }]
    ]);
    const engine = createModelReadEngine<TestRow, TestRow[]>({
      signature: 'incremental-order-change',
      model: 'TestRow',
      where: row => row.visible,
      options: { orderBy: [{ field: 'rank', direction: 'asc' }] },
      initial: () => [...rows.values()],
      read: id => rows.get(id),
      select: value => value
    });
    rows.set('row-1', { id: 'row-1', rank: 3, label: 'one', visible: true });

    engine.apply({ rows: [{ model: 'TestRow', id: 'row-1', fields: ['rank'] }], scopes: [], mode: 'delta' });

    expect(engine.value.map(row => row.id)).toEqual(['row-2', 'row-1']);
  });

  it('resorts membership inserts and deletes', () => {
    const rows = new Map<string, TestRow>([
      ['row-1', { id: 'row-1', rank: 1, label: 'one', visible: true }],
      ['row-2', { id: 'row-2', rank: 3, label: 'two', visible: true }]
    ]);
    const engine = createModelReadEngine<TestRow, TestRow[]>({
      signature: 'incremental-membership',
      model: 'TestRow',
      where: row => row.visible,
      options: { orderBy: [{ field: 'rank', direction: 'asc' }] },
      initial: () => [...rows.values()],
      read: id => rows.get(id),
      select: value => value
    });
    rows.set('row-3', { id: 'row-3', rank: 2, label: 'three', visible: true });

    engine.apply({ rows: [{ model: 'TestRow', id: 'row-3', fields: ['rank', 'visible'] }], scopes: [], mode: 'delta' });
    expect(engine.value.map(row => row.id)).toEqual(['row-1', 'row-3', 'row-2']);
    rows.set('row-3', { id: 'row-3', rank: 2, label: 'three', visible: false });

    engine.apply({ rows: [{ model: 'TestRow', id: 'row-3', fields: ['visible'] }], scopes: [], mode: 'delta' });
    expect(engine.value.map(row => row.id)).toEqual(['row-1', 'row-2']);
  });

  it('does not rebuild any of multiple delta readers for a sub-collection batch', () => {
    const rows = new Map(
      Array.from({ length: 200 }, (_, index) => {
        const id = `row-${index}`;
        return [id, { id, rank: index, label: `initial-${index}`, visible: true } satisfies TestRow];
      })
    );
    const initialCalls = [0, 0, 0];
    const engines = initialCalls.map((_, index) =>
      createModelReadEngine<TestRow, TestRow[]>({
        signature: `incremental-budget-${index}`,
        model: 'TestRow',
        where: row => row.visible,
        initial: () => {
          initialCalls[index] += 1;
          return [...rows.values()];
        },
      read: id => rows.get(id),
        select: value => value
      })
    );
    const changes = Array.from({ length: 100 }, (_, index) => {
      const id = `row-${index}`;
      rows.set(id, { id, rank: index, label: `updated-${index}`, visible: true });
      return { model: 'TestRow', id, fields: ['label'] };
    });

    engines.forEach(engine => engine.apply({ rows: changes, scopes: [], mode: 'delta' }));

    expect(initialCalls).toEqual([1, 1, 1]);
  });
});
