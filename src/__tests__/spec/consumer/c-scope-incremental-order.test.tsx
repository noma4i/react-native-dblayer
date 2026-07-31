import { act } from 'react';
import { defineModelRuntime, f } from '../../testApi';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; bucket: string; rank: number; label: string };

/**
 * A mounted scope reader maintains its row set incrementally, so every incremental step must land
 * on the state a full read would produce: one entry per row, in plane order. A row that moves,
 * changes, or leaves is the same row - it must never appear twice and never keep a stale position.
 */
describe('incremental scope reads match a full read', () => {
  let suffix = 0;
  const build = () => {
    setupSpecRuntime();
    const model = defineModelRuntime({
      id: `SpecScopeIncremental${++suffix}`,
      name: `SpecScopeIncremental${suffix}`,
      fields: { bucket: f.str(), rank: f.num(), label: f.str() },
      scopes: { feed: ({ by: { bucket: 'bucket' }, sort: { comparator: (left: Row, right: Row) => left.rank - right.rank, orderFields: ['rank'] } }) }
    });
    model.scopes.feed.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', rank: 1, label: 'first' },
      { id: 'r-2', bucket: 'a', rank: 2, label: 'second' },
      { id: 'r-3', bucket: 'a', rank: 3, label: 'third' }
    ]);
    return model;
  };

  it('keeps one entry when the FIRST row of the scope is updated in place', () => {
    const model = build();
    const reader = renderCounted(() => model.scopes.feed.use({ bucket: 'a' }));
    expect(reader.result().map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);

    act(() => model.update('r-1', { label: 'renamed' }));

    expect(reader.result().map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(reader.result()[0]?.label).toBe('renamed');
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
    reader.unmount();
  });

  it('moves a row to its new position when its order field changes', () => {
    const model = build();
    const reader = renderCounted(() => model.scopes.feed.use({ bucket: 'a' }));

    act(() => model.update('r-1', { rank: 9 }));

    expect(reader.result().map(row => row.id)).toEqual(['r-2', 'r-3', 'r-1']);
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-2', 'r-3', 'r-1']);
    reader.unmount();
  });

  it('moves a row back to the head without leaving a copy behind', () => {
    const model = build();
    const reader = renderCounted(() => model.scopes.feed.use({ bucket: 'a' }));

    act(() => model.update('r-3', { rank: 0 }));

    expect(reader.result().map(row => row.id)).toEqual(['r-3', 'r-1', 'r-2']);
    reader.unmount();
  });

  it('serves the same row set through the mounted reader and a fresh read after several moves', () => {
    const model = build();
    const reader = renderCounted(() => model.scopes.feed.use({ bucket: 'a' }));

    act(() => model.update('r-2', { rank: 0 }));
    act(() => model.update('r-3', { rank: -1 }));
    act(() => model.update('r-1', { rank: 5 }));

    const incremental = reader.result().map(row => row.id);
    expect(incremental).toEqual(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id));
    expect(incremental).toEqual(['r-3', 'r-2', 'r-1']);
    reader.unmount();
  });

  it('drops a destroyed row and leaves the rest in order', () => {
    const model = build();
    const reader = renderCounted(() => model.scopes.feed.use({ bucket: 'a' }));

    act(() => model.destroy('r-2'));

    expect(reader.result().map(row => row.id)).toEqual(['r-1', 'r-3']);
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['r-1', 'r-3']);
    reader.unmount();
  });

  it('keeps the reference of a row that did not change while a sibling moves', () => {
    const model = build();
    const reader = renderCounted(() => model.scopes.feed.use({ bucket: 'a' }));
    const untouched = reader.result()[1];

    act(() => model.update('r-1', { rank: 9 }));

    expect(reader.result().find(row => row.id === 'r-2')).toBe(untouched);
    reader.unmount();
  });
});
