import { clearAllCollections, computeLoadingState, configureDb, defineModel, devClearAllDataAndState } from '../index';
import type { Todo, TodoInput } from './helpers/testRuntime';
import { createTodoModel, installMemoryStorage, mockTransport } from './helpers/testRuntime';

const later = '2026-01-02T00:00:00.000Z';
const earlier = '2026-01-01T00:00:00.000Z';

describe('collection model core DSL', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('imports the root package with the mocked native storage modules', () => {
    installMemoryStorage();
    expect(typeof clearAllCollections.run).toBe('function');
  });

  it('supports stored inserts and snapshot reads', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: earlier });
    model.insertStored({ id: '2', title: 'Two', listId: 'b', done: true, updatedAt: later });

    expect(model.get('1')?.title).toBe('One');
    expect(model.getWhere({ listId: 'a' }).map(item => item.id)).toEqual(['1']);
    expect(model.getFirstWhere({ done: true })?.id).toBe('2');
    expect(model.getAll().map(item => item.id)).toEqual(['1', '2']);
  });

  it('exposes the backing collection through a public read accessor', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: earlier });

    expect(model.collection).toBe(model._collection);
    expect(model.collection.state.get('1')?.title).toBe('One');
  });

  it('adds statics that compose the base model DSL', () => {
    installMemoryStorage();
    const model = defineModel<TodoInput, Todo, { currentId: () => string | undefined }>({
      id: 'static-current-id-model',
      name: 'StaticCurrentIdModel',
      normalize: input => ({
        id: input.id,
        title: input.title,
        listId: input.listId ?? null,
        done: input.done ?? false,
        updatedAt: input.updatedAt ?? null
      }),
      statics: baseModel => ({
        currentId: () => baseModel.getFirst()?.id
      })
    });

    expect(model.currentId()).toBeUndefined();

    model.insertStored({ id: 'singleton', title: 'Singleton', listId: null, done: false, updatedAt: earlier });
    expect(model.currentId()).toBe('singleton');

    model.clearScope();
    expect(model.currentId()).toBeUndefined();
  });

  it('preserves the full base API on models with typed statics', () => {
    installMemoryStorage();
    const model = defineModel<TodoInput, Todo, { currentId: () => string | undefined }>({
      id: 'typed-static-model',
      name: 'TypedStaticModel',
      normalize: input => ({
        id: input.id,
        title: input.title,
        listId: input.listId ?? null,
        done: input.done ?? false,
        updatedAt: input.updatedAt ?? null
      }),
      statics: baseModel => ({
        currentId: () => baseModel.getFirst()?.id
      })
    });

    model.insertStored({ id: 'typed', title: 'Typed', listId: null, done: false, updatedAt: earlier });

    const currentId: string | undefined = model.currentId();
    const allRows: Todo[] = model.getAll();

    expect(currentId).toBe('typed');
    expect(allRows.map(row => row.id)).toEqual(['typed']);
    expect(model.getFirst()?.title).toBe('Typed');
    model.clearScope();
  });

  it('throws when statics collide with base model keys', () => {
    installMemoryStorage();

    expect(() =>
      defineModel<TodoInput, Todo, { getFirst: () => undefined }>({
        id: 'static-collision-model',
        name: 'StaticCollisionModel',
        normalize: input => ({
          id: input.id,
          title: input.title,
          listId: input.listId ?? null,
          done: input.done ?? false,
          updatedAt: input.updatedAt ?? null
        }),
        statics: () => ({
          getFirst: () => undefined
        })
      })
    ).toThrow('[StaticCollisionModel] statics cannot override base model key "getFirst".');
  });

  it('computes exported ready and counting loading states', () => {
    expect(computeLoadingState('ready', false)).toEqual({
      phase: 'ready',
      hasData: false,
      isReady: true,
      showSkeleton: false,
      showData: false,
      showEmptyState: true,
      showRefreshIndicator: false,
      showFooterSpinner: false,
      showErrorBanner: false
    });

    expect(computeLoadingState('initial_loading', false)).toEqual({
      phase: 'initial_loading',
      hasData: false,
      isReady: false,
      showSkeleton: true,
      showData: false,
      showEmptyState: false,
      showRefreshIndicator: false,
      showFooterSpinner: false,
      showErrorBanner: false
    });

    expect(computeLoadingState('ready', true)).toEqual({
      phase: 'ready',
      hasData: true,
      isReady: true,
      showSkeleton: false,
      showData: true,
      showEmptyState: false,
      showRefreshIndicator: false,
      showFooterSpinner: false,
      showErrorBanner: false
    });
  });

  it('merges server data with timestamp and dedupe gates', () => {
    installMemoryStorage();
    const model = createTodoModel({ dedupeWindowMs: 1000 });
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    expect(
      model.applyServerData([{ id: '1', title: 'Initial', listId: 'a', updatedAt: later }], {
        mode: 'merge'
      })
    ).toEqual({ merged: 1 });
    expect(model.get('1')?.title).toBe('Initial');

    expect(
      model.applyServerData([{ id: '1', title: 'Stale', listId: 'a', updatedAt: earlier }], {
        mode: 'merge'
      })
    ).toEqual({ merged: 0 });
    expect(model.get('1')?.title).toBe('Initial');

    expect(
      model.applyServerData([{ id: '1', title: 'Fresh', listId: 'a', updatedAt: '2026-01-03T00:00:00.000Z' }], {
        mode: 'merge'
      })
    ).toEqual({ merged: 1 });
    expect(model.get('1')?.title).toBe('Fresh');

    expect(
      model.applyServerData([{ id: '2', title: 'Dedupe', listId: 'a', updatedAt: later }], {
        mode: 'merge'
      })
    ).toEqual({ merged: 1 });
    expect(
      model.applyServerData([{ id: '2', title: 'Dedupe', listId: 'a', updatedAt: later }], {
        mode: 'merge'
      })
    ).toEqual({ merged: 0 });
  });

  it('applies configureDb merge defaults unless the model specifies its own value', () => {
    installMemoryStorage();
    configureDb({
      transport: mockTransport({}),
      modelDefaults: { merge: { dedupeWindowMs: 1000 } }
    });
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    const defaultedModel = createTodoModel();
    const payload = [{ id: '1', title: 'One', listId: 'a', updatedAt: later }];

    expect(defaultedModel.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 1 });
    defaultedModel.clearScope();
    expect(defaultedModel.get('1')).toBeUndefined();
    expect(defaultedModel.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 0 });
    expect(defaultedModel.get('1')).toBeUndefined();

    const explicitModel = createTodoModel({ dedupeWindowMs: 0 });

    expect(explicitModel.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 1 });
    explicitModel.clearScope();
    expect(explicitModel.get('1')).toBeUndefined();
    expect(explicitModel.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 1 });
    expect(explicitModel.get('1')?.title).toBe('One');
  });

  it('applies configureDb merge defaults configured after model creation', () => {
    installMemoryStorage();
    const model = createTodoModel();
    configureDb({
      transport: mockTransport({}),
      modelDefaults: { merge: { dedupeWindowMs: 1000 } }
    });
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    const payload = [{ id: '1', title: 'One', listId: 'a', updatedAt: later }];

    expect(model.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 1 });
    model.clearScope();
    expect(model.get('1')).toBeUndefined();
    expect(model.applyServerData(payload, { mode: 'merge' })).toEqual({ merged: 0 });
    expect(model.get('1')).toBeUndefined();
  });

  it('replaces server data globally and within a scoped filter', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.applyServerData(
      [
        { id: 'a1', title: 'A1', listId: 'a', updatedAt: earlier },
        { id: 'a2', title: 'A2', listId: 'a', updatedAt: earlier },
        { id: 'b1', title: 'B1', listId: 'b', updatedAt: earlier }
      ],
      { mode: 'merge' }
    );

    expect(
      model.applyServerData([{ id: 'a1', title: 'A1 updated', listId: 'a', updatedAt: later }], {
        mode: 'replace',
        scope: { listId: 'a' },
        _scopeFilter: item => (item as { listId?: string | null }).listId === 'a'
      })
    ).toEqual({ merged: 1, deleted: 1 });
    expect(model.getAll().map(item => item.id).sort()).toEqual(['a1', 'b1']);
    expect(model.get('a1')?.title).toBe('A1 updated');

    expect(
      model.applyServerData([{ id: 'c1', title: 'C1', listId: 'c', updatedAt: later }], {
        mode: 'replace'
      })
    ).toEqual({ merged: 1, deleted: 2 });
    expect(model.getAll().map(item => item.id)).toEqual(['c1']);
  });

  it('supports patch, destroy, bulk destroy, raw replacement, and clear scope', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.applyServerData(
      [
        { id: '1', title: 'One', listId: 'a', updatedAt: earlier },
        { id: '2', title: 'Two', listId: 'a', updatedAt: earlier },
        { id: '3', title: 'Three', listId: 'b', updatedAt: earlier }
      ],
      { mode: 'merge' }
    );

    expect(model.patch('1', { done: true, updatedAt: later })).toBe(true);
    expect(model.get('1')?.done).toBe(true);
    expect(model.patch('1', { title: 'Too old', updatedAt: earlier })).toBe(false);
    expect(model.get('1')?.title).toBe('One');

    expect(model.destroy('2')).toBe(true);
    expect(model.destroy('missing')).toBe(false);
    expect(model.destroyMany(['1', 'missing'])).toBe(1);
    expect(model.destroyWhere({ listId: 'b' })).toBe(1);
    expect(model.getAll()).toEqual([]);

    model.insertStored({ id: 'old', title: 'Old', listId: null, done: false, updatedAt: earlier });
    expect(model.replaceRaw('old', { id: 'new', title: 'New', listId: null, updatedAt: later })).toBe(true);
    expect(model.get('old')).toBeUndefined();
    expect(model.get('new')?.title).toBe('New');

    model.clearScope();
    expect(model.getAll()).toEqual([]);
  });

  it('persists freshness metadata and applies stale-time checks', () => {
    const storage = installMemoryStorage();
    const model = createTodoModel({ id: 'freshness-model', staleTime: 1000 });
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: later });
    model.markFetched({ listId: 'a' }, { empty: false });

    expect(model.getFetchState({ listId: 'a' })).toMatchObject({ touchedAt: 1000, empty: false });
    expect(model.shouldSkipInitialFetch({ listId: 'a' }, 1000)).toBe(true);
    expect(Object.keys(storage.dump()).some(key => key.startsWith('tanstack-db-freshness:freshness-model:'))).toBe(true);

    jest.spyOn(Date, 'now').mockReturnValue(2501);
    expect(model.shouldSkipInitialFetch({ listId: 'a' }, 1000)).toBe(false);

    model.markFetched({ listId: 'empty' }, { empty: true });
    expect(model.shouldSkipInitialFetch({ listId: 'empty' }, 1000)).toBe(true);
  });
});
