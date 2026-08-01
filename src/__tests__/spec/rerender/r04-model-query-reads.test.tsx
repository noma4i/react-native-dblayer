import { act } from 'react';
import { defineModelRuntime, f, resetRuntime } from '../../testApi';
import { diagnostics, renderCounted, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; bucket: string; rank: number; label: string };

let suffix = 0;
const createRows = () => {
  setupSpecRuntime();
  return defineModelRuntime({
    id: `SpecModelQueryReads${(suffix += 1)}`,
    name: `SpecModelQueryReads${suffix}`,
    fields: { bucket: f.str(), rank: f.num(), label: f.str() }
  });
};

const seed = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `r-${String(index).padStart(4, '0')}`, bucket: index % 2 === 0 ? 'a' : 'b', rank: index, label: `label-${index}` }));

/**
 * Owner contract of the model read path. A declared read is a live query the engine maintains, so
 * the guarantees a reader depends on are stated here: the result equals the same filter and order
 * computed from scratch, an update that changes nothing observable changes no row instance, and an
 * update to an order field moves exactly that row.
 */
describe('model query reads', () => {
  it('matches a reference computation after a hundred-row delta', () => {
    const rows = createRows();
    rows.insertMany(seed(300));
    const reader = renderCounted(() => rows.use.where({ bucket: 'a' }).orderBy('rank', 'desc').rows());

    act(() => {
      rows.insertMany(Array.from({ length: 100 }, (_, index) => ({ id: `late-${index}`, bucket: index % 2 === 0 ? 'a' : 'b', rank: 1_000 + index, label: `late-${index}` })));
    });

    const reference = [...rows.all()]
      .filter(row => row.bucket === 'a')
      .sort((left, right) => right.rank - left.rank || (left.id < right.id ? -1 : 1))
      .map(row => row.id);
    expect(reader.result().map(row => row.id)).toEqual(reference);
    reader.unmount();
  });

  it('keeps row instances when an update touches no selected field', () => {
    const rows = createRows();
    rows.insertMany(seed(10));
    const reader = renderCounted(() => rows.use.where({ bucket: 'a' }).select(row => ({ id: row.id, label: row.label })).rows());
    const before = reader.result();

    act(() => {
      rows.update('r-0002', { rank: 999 });
    });

    const after = reader.result();
    expect(after.map(row => row.id)).toEqual(before.map(row => row.id));
    for (const [index, row] of after.entries()) expect(row).toBe(before[index]);
    reader.unmount();
  });

  it('moves exactly the row whose order field changed', () => {
    const rows = createRows();
    rows.insertMany(seed(6));
    const reader = renderCounted(() => rows.use.where({}).orderBy('rank', 'asc').rows());
    expect(reader.result().map(row => row.id)).toEqual(['r-0000', 'r-0001', 'r-0002', 'r-0003', 'r-0004', 'r-0005']);

    act(() => {
      rows.update('r-0001', { rank: 10 });
    });

    expect(reader.result().map(row => row.id)).toEqual(['r-0000', 'r-0002', 'r-0003', 'r-0004', 'r-0005', 'r-0001']);
    reader.unmount();
  });

  it('reports one delta for one changed row however many readers are mounted', () => {
    const rows = createRows();
    rows.insertMany(seed(50));
    const readers = Array.from({ length: 5 }, () => renderCounted(() => rows.use.where({ bucket: 'a' }).rows()));
    diagnostics().reset();

    act(() => {
      rows.update('r-0002', { label: 'changed' });
    });

    const work = diagnostics().snapshot();
    expect(work.readEngineApplies).toBe(1);
    expect(work.readEngineDeltaRows).toBe(1);
    for (const reader of readers) reader.unmount();
  });

  it('serves the first row of an unfiltered ordered read', () => {
    const rows = createRows();
    rows.insertMany(seed(5));
    const reader = renderCounted(() => rows.use.first(null, { orderBy: { field: 'rank', direction: 'desc' } }));

    expect(reader.result()).toMatchObject({ id: 'r-0004' });
    reader.unmount();
  });

  it('serves a fresh result after a runtime reset', () => {
    const rows = createRows();
    rows.insertMany(seed(4));
    const first = renderCounted(() => rows.use.where({ bucket: 'a' }).rows());
    expect(first.result().map(row => row.id)).toEqual(['r-0000', 'r-0002']);
    first.unmount();

    act(() => {
      resetRuntime();
    });
    rows.insert({ id: 'after-reset', bucket: 'a', rank: 0, label: 'after' });

    const second = renderCounted(() => rows.use.where({ bucket: 'a' }).rows());
    expect(second.result().map(row => row.id)).toEqual(['after-reset']);
    second.unmount();
  });
});
