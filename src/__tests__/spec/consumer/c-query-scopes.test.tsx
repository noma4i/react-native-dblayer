import { act } from 'react-test-renderer';
import { defineModel, f } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// queryScopes: named reusable predicate fragments exposed as use.<name>(extra?) builders.

const createItems = (suffix: string) =>
  defineModel({
    id: `SpecConsumerQueryScopes${suffix}`,
    name: `SpecConsumerQueryScopes${suffix}`,
    fields: { id: f.str(), score: f.num(), status: f.str() },
    queryScopes: {
      ready: { where: { status: 'ready' }, orderBy: { field: 'score', direction: 'desc' } },
      topReady: { where: { status: 'ready' }, orderBy: { field: 'score', direction: 'desc' }, limit: 2 }
    }
  });

const seedItems = (items: ReturnType<typeof createItems>): void => {
  items.insertStoredMany([
    { id: 'a', score: 1, status: 'ready' },
    { id: 'b', score: 5, status: 'ready' },
    { id: 'c', score: 9, status: 'ready' },
    { id: 'd', score: 7, status: 'done' }
  ]);
};

describe('queryScopes', () => {
  it('reads a named predicate through the standard builder with the spec order applied', () => {
    setupSpecRuntime();
    const items = createItems('Read');
    seedItems(items);
    const reader = renderCounted(() => items.use.ready().rows());
    expect(reader.result().map(row => row.id)).toEqual(['c', 'b', 'a']);
    reader.unmount();
  });

  it('applies the spec limit and rides builder terminals for free', () => {
    setupSpecRuntime();
    const items = createItems('Terminals');
    seedItems(items);
    const top = renderCounted(() => items.use.topReady().rows());
    const exists = renderCounted(() => items.use.ready().exists());
    const scores = renderCounted(() => items.use.ready().pluck('score'));
    expect(top.result().map(row => row.id)).toEqual(['c', 'b']);
    expect(exists.result()).toBe(true);
    expect(scores.result()).toEqual([9, 5, 1]);
    top.unmount();
    exists.unmount();
    scores.unmount();
  });

  it('composes extra criteria with and-semantics', () => {
    setupSpecRuntime();
    const items = createItems('Compose');
    seedItems(items);
    const reader = renderCounted(() => items.use.ready({ score: { gte: 5 } }).rows());
    expect(reader.result().map(row => row.id)).toEqual(['c', 'b']);
    reader.unmount();
  });

  it('stays reactive with counted renders', () => {
    setupSpecRuntime();
    const items = createItems('Reactive');
    seedItems(items);
    const reader = renderCounted(() => items.use.ready().rows());
    const renders = reader.renders();
    act(() => {
      items.insertStored({ id: 'e', score: 20, status: 'ready' });
    });
    expect(reader.renders()).toBe(renders + 1);
    expect(reader.result()[0]?.id).toBe('e');
    act(() => {
      items.insertStored({ id: 'f', score: 30, status: 'done' });
    });
    expect(reader.renders()).toBe(renders + 1);
    reader.unmount();
  });

  it('throws at define time when a queryScope name collides with a built-in use key', () => {
    setupSpecRuntime();
    expect(() =>
      defineModel({
        id: 'SpecConsumerQueryScopesCollide',
        name: 'SpecConsumerQueryScopesCollide',
        fields: { id: f.str(), status: f.str() },
        queryScopes: { row: { where: { status: 'ready' } } }
      })
    ).toThrow("queryScope 'row' collides with a built-in use key");
  });
});
