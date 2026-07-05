import { clearAllCollections, devClearAllDataAndState } from '../index';
import { createTodoModel, installMemoryStorage } from './helpers/testRuntime';

const later = '2026-01-02T00:00:00.000Z';
const earlier = '2026-01-01T00:00:00.000Z';

describe('collection model core DSL', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    devClearAllDataAndState();
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
