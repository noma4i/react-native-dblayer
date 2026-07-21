import { defineModel, f } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// defaultOrder: implicit order for order-less reads; explicit orderBy fully replaces it.

type OrderedRow = { id: string; score: number; name: string };

const createOrdered = (suffix: string) =>
  defineModel({
    id: `SpecConsumerDefaultOrder${suffix}`,
    name: `SpecConsumerDefaultOrder${suffix}`,
    fields: { id: f.str(), score: f.num(), name: f.str() },
    defaultOrder: { field: 'score', direction: 'desc' }
  });

const seedShuffled = (items: { insertStoredMany(rows: OrderedRow[]): void }): void => {
  items.insertStoredMany([
    { id: 'b', score: 5, name: 'mid' },
    { id: 'c', score: 9, name: 'top' },
    { id: 'a', score: 1, name: 'low' }
  ]);
};

describe('defaultOrder', () => {
  it('orders getWhere results when no explicit orderBy is passed, and yields to an explicit one', () => {
    setupSpecRuntime();
    const items = createOrdered('GetWhere');
    seedShuffled(items);
    expect(items.getWhere({}).map(row => row.id)).toEqual(['c', 'b', 'a']);
    expect(items.getWhere({}, { orderBy: { field: 'score', direction: 'asc' } }).map(row => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('drives use.first selection and yields to an explicit orderBy', () => {
    setupSpecRuntime();
    const items = createOrdered('First');
    seedShuffled(items);
    const top = renderCounted(() => items.use.first({}));
    const low = renderCounted(() => items.use.first({}, { orderBy: { field: 'score', direction: 'asc' } }));
    expect(top.result()?.id).toBe('c');
    expect(low.result()?.id).toBe('a');
    top.unmount();
    low.unmount();
  });

  it('orders builder rows without .orderBy() and is fully replaced by .orderBy()', () => {
    setupSpecRuntime();
    const items = createOrdered('Builder');
    seedShuffled(items);
    const implicit = renderCounted(() => items.use.where({}).rows());
    const explicit = renderCounted(() => items.use.where({}).orderBy('score').rows());
    expect(implicit.result().map(row => row.id)).toEqual(['c', 'b', 'a']);
    expect(explicit.result().map(row => row.id)).toEqual(['a', 'b', 'c']);
    implicit.unmount();
    explicit.unmount();
  });

  it('ties break by id under defaultOrder', () => {
    setupSpecRuntime();
    const items = createOrdered('Ties');
    items.insertStoredMany([
      { id: 'z', score: 5, name: 'first-in' },
      { id: 'a', score: 5, name: 'second-in' }
    ]);
    expect(items.getWhere({}).map(row => row.id)).toEqual(['a', 'z']);
  });

  it('keeps natural storage order for models without defaultOrder', () => {
    setupSpecRuntime();
    const plain = defineModel({
      id: 'SpecConsumerDefaultOrderPlain',
      name: 'SpecConsumerDefaultOrderPlain',
      fields: { id: f.str(), score: f.num(), name: f.str() }
    });
    seedShuffled(plain);
    expect(plain.getWhere({}).map(row => row.id)).toEqual(['b', 'c', 'a']);
  });
});
