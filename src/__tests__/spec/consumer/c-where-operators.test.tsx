import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// DbWhere leaf operators: local predicates over stored rows, one call shape with equality leaves.

const createItems = (suffix: string) =>
  defineModel({
    id: `SpecConsumerWhereOps${suffix}`,
    name: `SpecConsumerWhereOps${suffix}`,
    fields: { id: f.str(), score: f.num(), name: f.str(), status: f.str() }
  });

const seedItems = (items: ReturnType<typeof createItems>): void => {
  items.insertStoredMany([
    { id: '1', score: 1, name: 'alpha', status: 'ready' },
    { id: '2', score: 5, name: 'bravo', status: 'ready' },
    { id: '3', score: 9, name: 'charlie', status: 'done' }
  ]);
};

describe('DbWhere comparison operators', () => {
  it('filters with gt/gte/lt/lte in builder reads', () => {
    setupSpecRuntime();
    const items = createItems('Ordering');
    seedItems(items);
    const gt = renderCounted(() => items.use.where({ score: { gt: 5 } }).orderBy('score').rows());
    const gte = renderCounted(() => items.use.where({ score: { gte: 5 } }).orderBy('score').rows());
    const lt = renderCounted(() => items.use.where({ score: { lt: 5 } }).orderBy('score').rows());
    const lte = renderCounted(() => items.use.where({ score: { lte: 5 } }).orderBy('score').rows());
    expect(gt.result().map(row => row.id)).toEqual(['3']);
    expect(gte.result().map(row => row.id)).toEqual(['2', '3']);
    expect(lt.result().map(row => row.id)).toEqual(['1']);
    expect(lte.result().map(row => row.id)).toEqual(['1', '2']);
    gt.unmount();
    gte.unmount();
    lt.unmount();
    lte.unmount();
  });

  it('bounds a range with two operators on one field', () => {
    setupSpecRuntime();
    const items = createItems('Range');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({ score: { gte: 2, lt: 9 } }).rows());
    expect(reader.result().map(row => row.id)).toEqual(['2']);
    reader.unmount();
  });

  it('matches in/notIn with id operand coercion', () => {
    setupSpecRuntime();
    const items = createItems('Membership');
    seedItems(items);
    const included = renderCounted(() => items.use.where({ id: { in: [1, 3] as unknown as string[] } }).orderBy('score').rows());
    const excluded = renderCounted(() => items.use.where({ id: { notIn: ['1', '3'] } }).orderBy('score').rows());
    expect(included.result().map(row => row.id)).toEqual(['1', '3']);
    expect(excluded.result().map(row => row.id)).toEqual(['2']);
    included.unmount();
    excluded.unmount();
  });

  it('matches substring with contains on string fields', () => {
    setupSpecRuntime();
    const items = createItems('Contains');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({ name: { contains: 'ar' } }).orderBy('score').rows());
    expect(reader.result().map(row => row.id)).toEqual(['3']);
    reader.unmount();
  });

  it('composes operators inside and/or/not nodes', () => {
    setupSpecRuntime();
    const items = createItems('Compose');
    seedItems(items);
    const reader = renderCounted(() =>
      items.use
        .where({ and: [{ status: 'ready' }, { or: [{ score: { lt: 2 } }, { not: { score: { lte: 5 } } }] }] })
        .orderBy('score')
        .rows()
    );
    expect(reader.result().map(row => row.id)).toEqual(['1']);
    reader.unmount();
  });

  it('keeps plain record leaf values on strict equality (no operator hijack)', () => {
    setupSpecRuntime();
    const items = createItems('Equality');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({ name: { unrelated: 'x' } as never }).rows());
    expect(reader.result()).toEqual([]);
    reader.unmount();
  });

  it('serves use.first and use.count with operator criteria', () => {
    setupSpecRuntime();
    const items = createItems('FirstCount');
    seedItems(items);
    const first = renderCounted(() => items.use.first({ score: { gte: 5 } }, { orderBy: { field: 'score', direction: 'desc' } }));
    const count = renderCounted(() => items.use.count({ score: { gte: 5 } }));
    expect(first.result()?.id).toBe('3');
    expect(count.result()).toBe(2);
    first.unmount();
    count.unmount();
  });

  it('applies operator criteria incrementally with counted renders and stable identity', () => {
    setupSpecRuntime();
    const items = createItems('Incremental');
    const reader = renderCounted(() => items.use.where({ score: { gte: 5 } }).orderBy('score').rows());
    const before = reader.renders();
    act(() => {
      items.insertStored({ id: '9', score: 7, name: 'delta', status: 'ready' });
    });
    expect(reader.renders() - before).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual(['9']);
    act(() => {
      items.patch('9', { score: 3 });
    });
    expect(reader.renders() - before).toBe(2);
    expect(reader.result()).toEqual([]);
    const stable = reader.result();
    const rendersAfterLeave = reader.renders();
    act(() => {
      items.patch('9', { name: 'delta-renamed' });
    });
    act(() => {
      items.insertStored({ id: '10', score: 1, name: 'foxtrot', status: 'ready' });
    });
    expect(reader.renders()).toBe(rendersAfterLeave);
    expect(reader.result()).toBe(stable);
    reader.unmount();
  });

  it('survives resetRuntime: operator reads land on the fresh runtime path', () => {
    setupSpecRuntime();
    const items = createItems('Reset');
    seedItems(items);
    const probe = renderCounted(() => items.use.where({ score: { gte: 5 } }).rows());
    expect(probe.result().length).toBe(2);
    probe.unmount();
    resetRuntime();
    setupSpecRuntime();
    const fresh = renderCounted(() => items.use.where({ score: { gte: 5 } }).rows());
    expect(fresh.result()).toEqual([]);
    act(() => {
      items.insertStored({ id: '7', score: 8, name: 'echo', status: 'ready' });
    });
    expect(fresh.result().map(row => row.id)).toEqual(['7']);
    fresh.unmount();
  });
});
