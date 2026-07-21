import { act } from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// patchWhere/destroyWhere: one journal plan, one commit, snapshot match semantics.

const createItems = (suffix: string) =>
  defineModel({
    id: `SpecConsumerBatchWrites${suffix}`,
    name: `SpecConsumerBatchWrites${suffix}`,
    fields: { id: f.str(), score: f.num(), status: f.str() }
  });

const seedItems = (items: ReturnType<typeof createItems>): void => {
  items.insertStoredMany([
    { id: '1', score: 1, status: 'draft' },
    { id: '2', score: 5, status: 'draft' },
    { id: '3', score: 9, status: 'sent' }
  ]);
};

describe('patchWhere', () => {
  it('patches every matching row in one commit and returns the count', () => {
    setupSpecRuntime();
    const items = createItems('Patch');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({ status: 'archived' }).orderBy('score').rows());
    const renders = reader.renders();
    let affected = 0;
    act(() => {
      affected = items.patchWhere({ status: 'draft' }, { status: 'archived' });
    });
    expect(affected).toBe(2);
    expect(reader.renders()).toBe(renders + 1);
    expect(reader.result().map(row => row.id)).toEqual(['1', '2']);
    expect(items.get('3')?.status).toBe('sent');
    reader.unmount();
  });

  it('accepts operator criteria', () => {
    setupSpecRuntime();
    const items = createItems('PatchOps');
    seedItems(items);
    const affected = items.patchWhere({ score: { lt: 6 } }, { status: 'low' });
    expect(affected).toBe(2);
    expect(items.getWhere({ status: 'low' }).map(row => row.id).sort()).toEqual(['1', '2']);
  });

  it('returns 0 and stays silent when nothing matches', () => {
    setupSpecRuntime();
    const items = createItems('PatchNone');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({ status: 'draft' }).rows());
    const renders = reader.renders();
    let affected = -1;
    act(() => {
      affected = items.patchWhere({ status: 'missing' }, { status: 'archived' });
    });
    expect(affected).toBe(0);
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });
});

describe('destroyWhere', () => {
  it('destroys every matching row in one commit and returns the count', () => {
    setupSpecRuntime();
    const items = createItems('Destroy');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({}).orderBy('score').rows());
    const renders = reader.renders();
    let removed = 0;
    act(() => {
      removed = items.destroyWhere({ status: 'draft' });
    });
    expect(removed).toBe(2);
    expect(reader.renders()).toBe(renders + 1);
    expect(reader.result().map(row => row.id)).toEqual(['3']);
    expect(items.get('1')).toBeUndefined();
    reader.unmount();
  });

  it('returns 0 when nothing matches', () => {
    setupSpecRuntime();
    const items = createItems('DestroyNone');
    seedItems(items);
    expect(items.destroyWhere({ status: 'missing' })).toBe(0);
    expect(items.getAll()).toHaveLength(3);
  });
});
