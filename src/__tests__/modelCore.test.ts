import {
  belongsTo,
  clearAllCollections,
  computeLoadingState,
  configureDb,
  defineModel,
  devClearAllDataAndState,
  f
} from '../index';
import { createPersistentCollection } from '../core/createPersistentCollection';
import { DEFAULT_FETCH_STATE_MAX_AGE_MS, getCollectionFetchStateVersion, setCollectionFetchState } from '../core/freshnessStorage';
import { setDbLogger } from '../core/logger';
import type { InternalSyncContract } from '../types';
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
    expect(model.getFirst({ done: true })?.id).toBe('2');
    expect(model.getAll().map(item => item.id)).toEqual(['1', '2']);
  });

  it('exposes the backing collection through a public read accessor', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: earlier });

    expect(model.collection.state.get('1')?.title).toBe('One');
  });

  it('exposes custom normalization without writing model state', () => {
    installMemoryStorage();
    const model = createTodoModel();

    expect(model.normalize({ id: 'normalized', title: 'Normalized', done: true })).toEqual({
      id: 'normalized',
      title: 'Normalized',
      listId: null,
      done: true,
      updatedAt: null
    });
    expect(model.get('normalized')).toBeUndefined();
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

  it('infers fields-model statics without a manual surface type', () => {
    installMemoryStorage();
    const fields = {
      title: f.str(),
      updatedAt: f.str().nullDefault()
    };
    const model = defineModel({
      id: 'fields-statics-model',
      name: 'FieldsStaticsModel',
      fields,
      statics: baseModel => ({ currentTitle: () => baseModel.getFirst()?.title })
    });

    model.insertStored(model.buildStored({ id: 'fields-row', title: 'Fields' }));

    expect(model.currentTitle()).toBe('Fields');
  });

  it('preserves relation-aware rows inside statics', () => {
    installMemoryStorage();
    const userModel = createTodoModel();
    type MembershipInput = { id: string; userId: string; updatedAt?: string | null };
    type Membership = { id: string; userId: string; updatedAt: string | null };
    const relations = () => ({ user: belongsTo(userModel, { foreignKey: 'userId' }) });
    const model = defineModel({
      id: 'relation-aware-statics-model',
      name: 'RelationAwareStaticsModel',
      normalize: (input: MembershipInput): Membership => ({ id: input.id, userId: input.userId, updatedAt: input.updatedAt ?? null }),
      relations,
      statics: baseModel => ({ currentUserTitle: () => baseModel.getFirst()?.related.user?.title })
    });

    userModel.insertStored({ id: 'user-1', title: 'Owner', listId: null, done: false, updatedAt: earlier });
    model.insertStored({ id: 'membership-1', userId: 'user-1', updatedAt: earlier });

    expect(model.currentUserTitle()).toBe('Owner');
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
    expect(
      model.applyServerData([{ id: '2', title: 'Changed content', listId: 'a', updatedAt: later }], {
        mode: 'merge'
      })
    ).toEqual({ merged: 0 });
    expect(model.get('2')?.title).toBe('Dedupe');
  });

  it('suppresses no-snapshot merge resurrection only when the model opts into a TTL', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const protectedModel = createTodoModel({ resurrectionTtlMs: 1_000 });
    protectedModel.applyServerData([{ id: 'protected', title: 'Before', listId: 'a', updatedAt: later }], { mode: 'merge' });
    protectedModel.destroy('protected');

    expect(protectedModel.applyServerData([{ id: 'protected', title: 'Echo', listId: 'a', updatedAt: later }], { mode: 'merge' })).toEqual({ merged: 0 });
    expect(protectedModel.get('protected')).toBeUndefined();

    jest.spyOn(Date, 'now').mockReturnValue(2_000);
    expect(protectedModel.applyServerData([{ id: 'protected', title: 'Recreated', listId: 'a', updatedAt: later }], { mode: 'merge' })).toEqual({ merged: 1 });

    const defaultModel = createTodoModel();
    defaultModel.applyServerData([{ id: 'default', title: 'Before', listId: 'a', updatedAt: later }], { mode: 'merge' });
    defaultModel.destroy('default');
    expect(defaultModel.applyServerData([{ id: 'default', title: 'Allowed', listId: 'a', updatedAt: later }], { mode: 'merge' })).toEqual({ merged: 1 });
  });

  it.each(['merge', 'replace'] as const)('stores a newly introduced field when %s updates an existing row', mode => {
    installMemoryStorage();
    type EvolvingInput = { id: string; a: string; b?: { body: string }; updatedAt: string };
    type EvolvingRow = { id: string; a: string; b?: { body: string }; updatedAt: string };
    const model = defineModel<EvolvingInput, EvolvingRow>({
      id: `evolving-fields-${mode}`,
      name: `EvolvingFieldsModel:${mode}`,
      normalize: input => ({
        id: input.id,
        a: input.a,
        ...(input.b === undefined ? {} : { b: input.b }),
        updatedAt: input.updatedAt
      })
    });

    model.applyServerData([{ id: 'row-1', a: 'initial', updatedAt: earlier }], { mode });
    model.applyServerData([{ id: 'row-1', a: 'updated', b: { body: 'new field' }, updatedAt: later }], { mode });

    expect(model.get('row-1')?.b).toEqual({ body: 'new field' });
  });

  it.each([
    ['update', true],
    ['update', false],
    ['delete', true],
    ['delete', false]
  ] as const)('%s write failures are observable when __DEV__ is %s', (operation, isDev) => {
    installMemoryStorage();
    const collection = createPersistentCollection<{ id: string; title: string }>({ id: `write-failure-${operation}-${isDev}` });
    const failure = new Error(`${operation} failed`);
    const error = jest.fn();
    const originalDevDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
    Object.defineProperty(globalThis, '__DEV__', { configurable: true, value: isDev, writable: true });
    setDbLogger({ debug: jest.fn(), error });
    collection.insert({ id: 'row-1', title: 'Before' });

    try {
      if (operation === 'update') {
        jest.spyOn(collection._collection, 'update').mockImplementation(() => {
          throw failure;
        });
      } else {
        jest.spyOn(collection._collection, 'delete').mockImplementation(() => {
          throw failure;
        });
      }

      const write = () => {
        if (operation === 'update') {
          collection.update('row-1', draft => {
            draft.title = 'After';
          });
          return;
        }

        collection.delete('row-1');
      };

      if (isDev) {
        expect(write).toThrow(failure);
      } else {
        expect(write).not.toThrow();
      }
      expect(error).toHaveBeenCalledWith('[persistentCollection]', `${operation} failed`, {
        id: `write-failure-${operation}-${isDev}`,
        key: 'row-1',
        error: failure
      });
    } finally {
      if (originalDevDescriptor) {
        Object.defineProperty(globalThis, '__DEV__', originalDevDescriptor);
      } else {
        delete (globalThis as { __DEV__?: boolean }).__DEV__;
      }
      setDbLogger({ debug: () => {}, error: () => {} });
    }
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

    const scopedReplaceContract: InternalSyncContract = {
      mode: 'replace',
      scope: { listId: 'a' },
      _scopeFilter: item => (item as { listId?: string | null }).listId === 'a'
    };
    expect(model.applyServerData([{ id: 'a1', title: 'A1 updated', listId: 'a', updatedAt: later }], scopedReplaceContract)).toEqual({ merged: 1, deleted: 1 });
    expect(model.getAll().map(item => item.id).sort()).toEqual(['a1', 'b1']);
    expect(model.get('a1')?.title).toBe('A1 updated');

    expect(
      model.applyServerData([{ id: 'c1', title: 'C1', listId: 'c', updatedAt: later }], {
        mode: 'replace'
      })
    ).toEqual({ merged: 1, deleted: 2 });
    expect(model.getAll().map(item => item.id)).toEqual(['c1']);
  });

  it('protects rows written after a replace snapshot while pruning earlier rows', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: 'before', title: 'Before', listId: 'a', done: false, updatedAt: earlier });
    model.insertStored({ id: 'updated-after', title: 'Original', listId: 'a', done: false, updatedAt: earlier });
    const queryStartSeq = model.getCollectionWriteSeq();

    model.insertStored({ id: 'inserted-after', title: 'Inserted', listId: 'a', done: false, updatedAt: later });
    expect(model.patch('updated-after', { title: 'Updated', updatedAt: later })).toBe(true);

    expect(model.applyServerData([], { mode: 'replace', snapshotSeq: queryStartSeq })).toEqual({ merged: 0, deleted: 1 });
    expect(model.get('before')).toBeUndefined();
    expect(model.get('inserted-after')?.title).toBe('Inserted');
    expect(model.get('updated-after')?.title).toBe('Updated');
  });

  it('cleans a destroyed row write sequence', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: 'tracked', title: 'Tracked', listId: 'a', done: false, updatedAt: earlier });
    expect(model.getRowWriteSeq('tracked')).toBe(model.getCollectionWriteSeq());

    expect(model.destroy('tracked')).toBe(true);
    expect(model.getRowWriteSeq('tracked')).toBeUndefined();
    expect(model.getRowDeleteSeq('tracked')).toBe(model.getCollectionWriteSeq());
  });

  it('keeps a row destroyed after a replace request began out of the server response', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: 'destroyed-during-request', title: 'Local', listId: 'a', done: false, updatedAt: earlier });
    const queryStartSeq = model.getCollectionWriteSeq();
    expect(model.destroy('destroyed-during-request')).toBe(true);

    expect(
      model.applyServerData([{ id: 'destroyed-during-request', title: 'Server', listId: 'a', done: false, updatedAt: later }], {
        mode: 'replace',
        snapshotSeq: queryStartSeq
      })
    ).toEqual({ merged: 1, deleted: 0 });
    expect(model.get('destroyed-during-request')).toBeUndefined();
  });

  it('keeps a row destroyed after a merge request began out of the server response', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: 'merge-destroyed-during-request', title: 'Local', listId: 'a', done: false, updatedAt: earlier });
    const queryStartSeq = model.getCollectionWriteSeq();
    expect(model.destroy('merge-destroyed-during-request')).toBe(true);

    expect(
      model.applyServerData([{ id: 'merge-destroyed-during-request', title: 'Server', listId: 'a', done: false, updatedAt: later }], {
        mode: 'merge',
        snapshotSeq: queryStartSeq
      })
    ).toEqual({ merged: 0 });
    expect(model.get('merge-destroyed-during-request')).toBeUndefined();
  });

  it('accepts server rows deleted before the replace or merge request began', async () => {
    installMemoryStorage();
    const replaceModel = createTodoModel();
    replaceModel.insertStored({ id: 'replace-authoritative', title: 'Local', listId: 'a', done: false, updatedAt: earlier });
    expect(replaceModel.destroy('replace-authoritative')).toBe(true);
    const replaceStartSeq = replaceModel.getCollectionWriteSeq();
    await new Promise(resolve => setTimeout(resolve, 0));

    replaceModel.applyServerData([{ id: 'replace-authoritative', title: 'Server', listId: 'a', done: false, updatedAt: later }], {
      mode: 'replace',
      snapshotSeq: replaceStartSeq
    });
    expect(replaceModel.get('replace-authoritative')?.title).toBe('Server');

    const mergeModel = createTodoModel();
    mergeModel.insertStored({ id: 'merge-authoritative', title: 'Local', listId: 'a', done: false, updatedAt: earlier });
    expect(mergeModel.destroy('merge-authoritative')).toBe(true);
    const mergeStartSeq = mergeModel.getCollectionWriteSeq();
    await new Promise(resolve => setTimeout(resolve, 0));

    mergeModel.applyServerData([{ id: 'merge-authoritative', title: 'Server', listId: 'a', done: false, updatedAt: later }], {
      mode: 'merge',
      snapshotSeq: mergeStartSeq
    });
    expect(mergeModel.get('merge-authoritative')?.title).toBe('Server');
  });

  it('clears a delete tombstone when a local insert writes the same id again', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: 'reinserted', title: 'Original', listId: 'a', done: false, updatedAt: earlier });
    const queryStartSeq = model.getCollectionWriteSeq();
    expect(model.destroy('reinserted')).toBe(true);
    expect(model.getRowDeleteSeq('reinserted')).toBeDefined();

    model.insertStored({ id: 'reinserted', title: 'Reinserted', listId: 'a', done: false, updatedAt: later });
    expect(model.getRowDeleteSeq('reinserted')).toBeUndefined();

    model.applyServerData([{ id: 'reinserted', title: 'Server', listId: 'a', done: false, updatedAt: '2026-01-03T00:00:00.000Z' }], {
      mode: 'replace',
      snapshotSeq: queryStartSeq
    });
    expect(model.get('reinserted')?.title).toBe('Server');
  });

  it('preserves pre-watermark replace insertion behavior when no watermark is supplied', async () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: 'legacy-insert', title: 'Local', listId: 'a', done: false, updatedAt: earlier });
    expect(model.destroy('legacy-insert')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(
      model.applyServerData([{ id: 'legacy-insert', title: 'Server', listId: 'a', done: false, updatedAt: later }], { mode: 'replace' })
    ).toEqual({ merged: 1, deleted: 0 });
    expect(model.get('legacy-insert')?.title).toBe('Server');
  });

  it('keeps replace pruning unchanged without a write watermark', () => {
    installMemoryStorage();
    const model = createTodoModel();

    model.insertStored({ id: 'pruned', title: 'Pruned', listId: 'a', done: false, updatedAt: earlier });

    expect(model.applyServerData([], { mode: 'replace' })).toEqual({ merged: 0, deleted: 1 });
    expect(model.get('pruned')).toBeUndefined();
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
    expect(model.shouldSkipInitialFetch({ listId: 'empty' }, 1000)).toBe(false);
    expect(model.shouldSkipInitialFetch({ listId: 'empty' }, 1000, 1000)).toBe(true);
  });

  it('uses a separate empty stale-time that can be overridden by request config', () => {
    installMemoryStorage();
    const model = createTodoModel({ id: 'freshness-empty-ttl', staleTime: 1000, emptyStaleTime: 100 });
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    model.markFetched({ listId: 'empty' }, { empty: true });

    jest.spyOn(Date, 'now').mockReturnValue(1050);
    expect(model.shouldSkipInitialFetch({ listId: 'empty' })).toBe(true);

    jest.spyOn(Date, 'now').mockReturnValue(1150);
    expect(model.shouldSkipInitialFetch({ listId: 'empty' })).toBe(false);
    expect(model.shouldSkipInitialFetch({ listId: 'empty' }, 1000, 500)).toBe(true);

    jest.spyOn(Date, 'now').mockReturnValue(1501);
    expect(model.shouldSkipInitialFetch({ listId: 'empty' }, 1000, 500)).toBe(false);
  });

  it('bumps fetch-state versions only when fetch-state changes', () => {
    installMemoryStorage();
    const model = createTodoModel({ id: 'freshness-version-bounds', staleTime: 1000 });
    const initialVersion = getCollectionFetchStateVersion('freshness-version-bounds');

    model.insertStored({ id: '1', title: 'One', listId: 'a', done: false, updatedAt: later });
    model.patch('1', { title: 'One updated', updatedAt: '2026-01-03T00:00:00.000Z' });
    expect(getCollectionFetchStateVersion('freshness-version-bounds')).toBe(initialVersion);

    model.markFetched({ listId: 'a' }, { empty: false });
    expect(getCollectionFetchStateVersion('freshness-version-bounds')).toBe(initialVersion + 1);
    expect(model.getFetchState({ listId: 'a' })).toMatchObject({ empty: false });
    expect(getCollectionFetchStateVersion('freshness-version-bounds')).toBe(initialVersion + 1);

    model.clearFetchState({ listId: 'a' });
    expect(getCollectionFetchStateVersion('freshness-version-bounds')).toBe(initialVersion + 2);
  });

  it('prunes stale fetch-state metadata during configureDb', () => {
    const storage = installMemoryStorage();
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000_000);

    setCollectionFetchState(
      'freshness-configure-prune',
      { touchedAt: Date.now() - DEFAULT_FETCH_STATE_MAX_AGE_MS - 1, empty: false },
      'stale',
      { listId: 'stale' }
    );
    setCollectionFetchState(
      'freshness-configure-prune',
      { touchedAt: Date.now() - DEFAULT_FETCH_STATE_MAX_AGE_MS + 1, empty: false },
      'fresh',
      { listId: 'fresh' }
    );

    configureDb({
      storage,
      transport: mockTransport({})
    });

    const keys = Object.keys(storage.dump()).filter(key => key.startsWith('tanstack-db-freshness:freshness-configure-prune:'));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('fresh');
  });

  it('clears only matching scoped fetch-state records when rows are destroyed', () => {
    installMemoryStorage();
    const model = createTodoModel({ id: 'freshness-destroy-scopes', staleTime: 1000 });
    model.insertStored({ id: 'a1', title: 'A1', listId: 'a', done: false, updatedAt: later });
    model.insertStored({ id: 'a2', title: 'A2', listId: 'a', done: false, updatedAt: later });
    model.insertStored({ id: 'b1', title: 'B1', listId: 'b', done: false, updatedAt: later });
    model.markFetched(undefined, { empty: false });
    model.markFetched({ listId: 'a' }, { empty: false });
    model.markFetched({ listId: 'b' }, { empty: false });

    expect(model.destroy('a1')).toBe(true);

    expect(model.getFetchState({ listId: 'a' })).toBeNull();
    expect(model.getFetchState({ listId: 'b' })).toMatchObject({ empty: false });
    expect(model.getFetchState()).toMatchObject({ empty: false });

    expect(model.destroyWhere({ listId: 'b' })).toBe(1);

    expect(model.getFetchState({ listId: 'b' })).toBeNull();
    expect(model.getFetchState()).toMatchObject({ empty: false });
  });
});
