import { act } from 'react-test-renderer';
import { defineModel, f, resetRuntime } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

// Builder terminal contracts: last(), pluck(field), exists().

const createItems = (suffix: string) =>
  defineModel({
    id: `SpecConsumerBuilderTerm${suffix}`,
    name: `SpecConsumerBuilderTerm${suffix}`,
    fields: { id: f.str(), score: f.num(), name: f.str(), status: f.str() }
  });

const seedItems = (items: ReturnType<typeof createItems>): void => {
  items.insertStoredMany([
    { id: '1', score: 1, name: 'alpha', status: 'ready' },
    { id: '2', score: 5, name: 'bravo', status: 'ready' },
    { id: '3', score: 9, name: 'charlie', status: 'done' }
  ]);
};

describe('builder last()', () => {
  it('returns the last row of the ordered result and undefined when empty', () => {
    setupSpecRuntime();
    const items = createItems('Last');
    seedItems(items);
    const last = renderCounted(() => items.use.where({ status: 'ready' }).orderBy('score').last());
    const empty = renderCounted(() => items.use.where({ status: 'missing' }).orderBy('score').last());
    expect(last.result()?.id).toBe('2');
    expect(empty.result()).toBeUndefined();
    last.unmount();
    empty.unmount();
  });

  it('respects limit before taking the last row', () => {
    setupSpecRuntime();
    const items = createItems('LastLimit');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({}).orderBy('score').limit(2).last());
    expect(reader.result()?.id).toBe('2');
    reader.unmount();
  });
});

describe('builder pluck()', () => {
  it('plucks the field in declared order with stable identity across irrelevant changes', () => {
    setupSpecRuntime();
    const items = createItems('Pluck');
    seedItems(items);
    const reader = renderCounted(() => items.use.where({ status: 'ready' }).orderBy('score').pluck('name'));
    expect(reader.result()).toEqual(['alpha', 'bravo']);
    const stable = reader.result();
    const renders = reader.renders();
    act(() => {
      items.patch('1', { score: 2 });
    });
    expect(reader.result()).toBe(stable);
    expect(reader.renders()).toBe(renders);
    act(() => {
      items.patch('1', { name: 'alpha-2' });
    });
    expect(reader.renders()).toBe(renders + 1);
    expect(reader.result()).toEqual(['alpha-2', 'bravo']);
    reader.unmount();
  });

  it('plucks from projected rows when select is declared', () => {
    setupSpecRuntime();
    const items = createItems('PluckSelect');
    seedItems(items);
    const reader = renderCounted(() =>
      items.use
        .where({ status: 'ready' })
        .orderBy('score')
        .select(row => ({ label: `${row.name}:${row.score}` }))
        .pluck('label')
    );
    expect(reader.result()).toEqual(['alpha:1', 'bravo:5']);
    reader.unmount();
  });
});

describe('builder exists()', () => {
  it('flips only on answer transitions with counted renders', () => {
    setupSpecRuntime();
    const items = createItems('Exists');
    const reader = renderCounted(() => items.use.where({ status: 'ready' }).exists());
    expect(reader.result()).toBe(false);
    const renders = reader.renders();
    act(() => {
      items.insertStored({ id: '1', score: 1, name: 'alpha', status: 'ready' });
    });
    expect(reader.result()).toBe(true);
    expect(reader.renders()).toBe(renders + 1);
    act(() => {
      items.insertStored({ id: '2', score: 5, name: 'bravo', status: 'ready' });
    });
    expect(reader.renders()).toBe(renders + 1);
    act(() => {
      items.destroyMany(['1', '2']);
    });
    expect(reader.result()).toBe(false);
    expect(reader.renders()).toBe(renders + 2);
    reader.unmount();
  });

  it('respects require(): rows missing required fields do not count', () => {
    setupSpecRuntime();
    const items = createItems('ExistsRequire');
    items.insertStored({ id: '1', score: 1, status: 'ready' } as never);
    const bare = renderCounted(() => items.use.where({ status: 'ready' }).exists());
    const required = renderCounted(() => items.use.where({ status: 'ready' }).require('name').exists());
    expect(bare.result()).toBe(true);
    expect(required.result()).toBe(false);
    bare.unmount();
    required.unmount();
  });

  it('survives resetRuntime onto the fresh runtime path', () => {
    setupSpecRuntime();
    const items = createItems('ExistsReset');
    seedItems(items);
    const probe = renderCounted(() => items.use.where({ status: 'ready' }).exists());
    expect(probe.result()).toBe(true);
    probe.unmount();
    resetRuntime();
    setupSpecRuntime();
    const fresh = renderCounted(() => items.use.where({ status: 'ready' }).exists());
    expect(fresh.result()).toBe(false);
    act(() => {
      items.insertStored({ id: '7', score: 8, name: 'echo', status: 'ready' });
    });
    expect(fresh.result()).toBe(true);
    fresh.unmount();
  });
});
