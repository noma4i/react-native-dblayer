import { SyncFeed } from '../../testApi';
import { createModelStore, publishProjectedBatch, runInApplyBatch, storeScopeCollection } from '../../../core/store';
import { keysForSequence } from '../../../core/orderKey';
import { createMemoryPlane, diagnostics } from '../helpers/harness';

type Row = { id: string } & Record<string, unknown>;

let storeTag = 0;

const buildStore = () =>
  createModelStore<Row>({
    modelId: `SpecStoreContract${(storeTag += 1)}`,
    now: () => Date.now(),
    storage: createMemoryPlane(),
    prefix: () => 'spec-store:',
    applyWriteGate: (_previous, incoming) => incoming
  });

const entriesFor = (ids: readonly string[]): Array<{ id: string; orderKey: string }> => {
  const keys = keysForSequence(ids.length);
  return ids.map((id, index) => ({ id, orderKey: keys[index]! }));
};

describe('model store', () => {
  it('serves scope joins without falling back to a full entity collection load', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = buildStore();
      store.upsert({ id: 'row-1' });
      store.applyScopeChanges([{ scopeKey: 'scope-1', entries: entriesFor(['row-1']) }]);
      store.markReady();

      expect(store.scopeCollection('scope-1').toArray()).toMatchObject([{ id: 'row-1' }]);
      expect(warn.mock.calls.filter(([message]) => String(message).includes('Join requires an index'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a snapshot read from retaining a live scope collection', () => {
    const store = buildStore();
    store.upsert({ id: 'row-1' });
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries: entriesFor(['row-1']) }]);
    store.markReady();
    const collections = (globalThis as Record<string, unknown>).__DBLAYER_STORE_SCOPE_COLLECTIONS__ as { count(): number };
    const before = collections.count();

    expect(store.scopeCollection('scope-1').toArray()).toMatchObject([{ id: 'row-1' }]);
    expect(collections.count()).toBe(before);

    const release = store.scopeCollection('scope-1').subscribe(() => undefined);
    expect(collections.count()).toBe(before + 1);
    release();
    expect(collections.count()).toBe(before);
  });

  it('lands an inserted row into a live scope as one delta change at 300 and 3000 rows', () => {
    const measure = (size: number): { changes: number; position: number } => {
      const store = buildStore();
      const ids = Array.from({ length: size }, (_, index) => `row-${index}`);
      for (const id of ids) store.upsert({ id });
      const entries = entriesFor(ids);
      store.applyScopeChanges([{ scopeKey: 'scope-1', entries }]);
      store.markReady();
      const scope = store.scopeCollection('scope-1');
      const seen: unknown[] = [];
      const unsubscribe = scope.subscribe(changes => seen.push(...changes));

      const insertedId = 'row-inserted';
      store.upsert({ id: insertedId });
      const middle = Math.floor(size / 2);
      const between = `${entries[middle - 1]!.orderKey}V`;
      store.applyScopeChanges([{ scopeKey: 'scope-1', upserts: [{ id: insertedId, orderKey: between }] }]);

      const position = scope.toArray().findIndex(row => row.id === insertedId);
      unsubscribe();
      return { changes: seen.length, position };
    };

    expect(measure(300)).toEqual({ changes: 1, position: 150 });
    expect(measure(3000)).toEqual({ changes: 1, position: 1500 });
  });

  it('keeps scope reads empty until the store is marked ready', () => {
    const store = buildStore();
    store.upsert({ id: 'row-1', label: 'first' });
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries: entriesFor(['row-1']) }]);

    expect(store.scopeCollection('scope-1').toArray()).toEqual([]);

    store.markReady();

    expect(store.scopeCollection('scope-1').toArray()).toMatchObject([{ id: 'row-1', label: 'first' }]);
  });

  it('keeps membership identities distinct when scope and row segments contain colons', () => {
    const store = buildStore();
    store.upsert({ id: 'c' });
    store.upsert({ id: 'b:c' });
    store.applyScopeChanges([{ scopeKey: 'a:b', entries: entriesFor(['c']) }]);
    store.applyScopeChanges([{ scopeKey: 'a', entries: entriesFor(['b:c']) }]);
    store.markReady();

    expect(
      store
        .scopeCollection('a:b')
        .toArray()
        .map(row => row.id)
    ).toEqual(['c']);
    expect(
      store
        .scopeCollection('a')
        .toArray()
        .map(row => row.id)
    ).toEqual(['b:c']);
  });

  it('keeps persisted row identities distinct across model and row segments', () => {
    const storage = createMemoryPlane();
    const create = (modelId: string) =>
      createModelStore<Row>({
        modelId,
        now: () => Date.now(),
        storage,
        prefix: () => 'spec-store:',
        applyWriteGate: (_previous, incoming) => incoming
      });
    const first = create('a:b');
    const second = create('a');
    first.upsert({ id: 'c', owner: 'first' });
    second.upsert({ id: 'b:c', owner: 'second' });

    storage.set([...first.persistEntries(), ...second.persistEntries()]);

    expect(storage.keys('spec-store:row:')).toHaveLength(2);
  });

  it('serves buffered same-batch reads while the live scope holds the pre-batch value', () => {
    const store = buildStore();
    store.upsert({ id: 'seed', label: 'before' });
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries: entriesFor(['seed']) }]);
    store.markReady();
    const scope = store.scopeCollection('scope-1');
    expect(scope.toArray()).toMatchObject([{ id: 'seed', label: 'before' }]);

    runInApplyBatch(() => {
      store.upsert({ id: 'seed', label: 'after' });
      store.upsert({ id: 'row-1', label: 'buffered' });
      expect(store.read('seed')).toMatchObject({ label: 'after' });
      expect(store.read('row-1')).toMatchObject({ id: 'row-1', label: 'buffered' });
      expect(
        store
          .values()
          .map(row => row.id)
          .sort()
      ).toEqual(['row-1', 'seed']);
      expect(scope.toArray()).toMatchObject([{ id: 'seed', label: 'before' }]);
    });

    expect(store.read('seed')).toMatchObject({ label: 'after' });
    expect(scope.toArray()).toMatchObject([{ id: 'seed', label: 'after' }]);
  });

  it('aborts buffered rows and persistence markers when the batch throws', () => {
    const store = buildStore();
    store.upsert({ id: 'seed', label: 'before' });
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries: entriesFor(['seed']) }]);
    store.markReady();
    store.ackPersist();
    const scope = store.scopeCollection('scope-1');
    const seen: unknown[] = [];
    const unsubscribe = scope.subscribe(changes => seen.push(...changes));

    try {
      expect(() =>
        runInApplyBatch(() => {
          store.upsert({ id: 'seed', label: 'after' });
          store.upsert({ id: 'new-row', label: 'new' });
          store.destroy('new-row');
          throw new Error('apply failed');
        })
      ).toThrow('apply failed');

      expect(store.read('seed')).toMatchObject({ label: 'before' });
      expect(store.read('new-row')).toBeUndefined();
      expect(store.isTombstoned('new-row')).toBe(false);
      expect(store.persistEntries()).toEqual([]);
      expect(scope.toArray()).toMatchObject([{ id: 'seed', label: 'before' }]);
      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('nets a same-batch insert and destroy to no collection write', () => {
    const store = buildStore();
    store.markReady();

    runInApplyBatch(() => {
      store.upsert({ id: 'ghost' });
      store.destroy('ghost');
      expect(store.read('ghost')).toBeUndefined();
    });

    expect(store.read('ghost')).toBeUndefined();
    expect(store.values()).toEqual([]);
    expect(store.isTombstoned('ghost')).toBe(true);
  });

  it('removes only the requested entity and membership', () => {
    const store = buildStore();
    store.upsert({ id: 'row-1', label: 'first' });
    store.upsert({ id: 'row-2', label: 'second' });
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries: entriesFor(['row-1', 'row-2']) }]);
    store.markReady();

    store.destroy('row-1');
    store.applyScopeChanges([{ scopeKey: 'scope-1', detachIds: ['row-1'] }]);

    expect(store.read('row-1')).toBeUndefined();
    expect(store.read('row-2')).toMatchObject({ id: 'row-2' });
    expect(
      store
        .scopeCollection('scope-1')
        .toArray()
        .map(row => row.id)
    ).toEqual(['row-2']);
  });

  it('orders scope rows by membership order key using code points', () => {
    const byCodepoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
    const keys = ['b', 'A', 'a', 'B', 'Ab', 'aB'];
    const codepoint = [...keys].sort(byCodepoint);
    expect(codepoint).not.toEqual([...keys].sort((left, right) => left.localeCompare(right)));

    const store = buildStore();
    for (const key of keys) store.upsert({ id: `row-${key}` });
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries: keys.map(key => ({ id: `row-${key}`, orderKey: key })) }]);
    store.markReady();

    expect(
      store
        .scopeCollection('scope-1')
        .toArray()
        .map(row => row.id)
    ).toEqual(codepoint.map(key => `row-${key}`));
  });

  it('serves only memberships of the requested scope', () => {
    const store = buildStore();
    store.upsert({ id: 'scope-1-row' });
    store.upsert({ id: 'scope-2-row' });
    store.applyScopeChanges([
      { scopeKey: 'scope-1', entries: entriesFor(['scope-1-row']) },
      { scopeKey: 'scope-2', entries: entriesFor(['scope-2-row']) }
    ]);
    store.markReady();

    expect(
      store
        .scopeCollection('scope-1')
        .toArray()
        .map(row => row.id)
    ).toEqual(['scope-1-row']);
  });

  it('projects reposition upserts verbatim without recomputing any order', () => {
    const store = buildStore();
    store.upsert({ id: 'row-1' });
    store.upsert({ id: 'row-2' });
    const entries = entriesFor(['row-1', 'row-2']);
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries }]);
    store.markReady();

    store.applyScopeChanges([{ scopeKey: 'scope-1', upserts: [{ id: 'row-1', orderKey: `${entries[1]!.orderKey}V` }] }]);

    expect(
      store
        .scopeCollection('scope-1')
        .toArray()
        .map(row => row.id)
    ).toEqual(['row-2', 'row-1']);
  });

  it('writes nothing for a replaceAll whose id and key pairs are unchanged', () => {
    const store = buildStore();
    store.upsert({ id: 'row-1' });
    store.upsert({ id: 'row-2' });
    const entries = entriesFor(['row-1', 'row-2']);
    store.applyScopeChanges([{ scopeKey: 'scope-1', entries }]);
    store.markReady();
    const seen: unknown[] = [];
    const unsubscribe = store.scopeCollection('scope-1').subscribe(changes => seen.push(...changes));
    diagnostics().reset();

    store.applyScopeChanges([{ scopeKey: 'scope-1', entries }]);

    expect(seen).toEqual([]);
    expect(diagnostics().snapshot().membershipWrites).toBe(0);
    unsubscribe();
  });

  it('forwards tombstone pruning and rejects reads for an unregistered model', () => {
    let now = 0;
    const store = createModelStore<Row>({
      modelId: `SpecStorePrune${(storeTag += 1)}`,
      now: () => now,
      storage: createMemoryPlane(),
      prefix: () => 'spec-store:',
      applyWriteGate: (_previous, incoming) => incoming
    });
    store.upsert({ id: 'row-1' });
    store.destroy('row-1');
    now = 24 * 60 * 60 * 1000 + 1;

    expect(store.pruneTombstones()).toBe(1);
    expect(() => storeScopeCollection('SpecStoreMissing', 'scope-1')).toThrow('No store registered for model SpecStoreMissing');
  });

  it('publishes a row-only batch without allocating scope changes', () => {
    const modelId = `SpecStoreContract${storeTag + 1}`;
    buildStore();
    const publish = jest.fn();
    publishProjectedBatch(
      { publish },
      {
        rows: [{ model: modelId, id: 'row-1', fields: null, kind: 'upsert' }],
        scopes: [],
        mode: 'delta'
      }
    );

    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('sync feed', () => {
  const methods = () => ({
    begin: jest.fn(),
    write: jest.fn(),
    commit: jest.fn(),
    truncate: jest.fn(),
    markReady: jest.fn()
  });

  it('requires a connection and keeps a newer connection when an older disposer runs', () => {
    const feed = new SyncFeed<Row>();
    expect(() => feed.start()).toThrow('Store sync feed is not connected');

    const first = methods();
    const second = methods();
    const disconnectFirst = feed.sync(first);
    const disconnectSecond = feed.sync(second);
    disconnectFirst();

    feed.start();
    feed.pushMessage({ type: 'insert', value: { id: 'row-1' } } as never);
    feed.finish();
    feed.truncate();
    feed.markReady();

    expect(second.begin).toHaveBeenCalledTimes(1);
    expect(second.write).toHaveBeenCalledTimes(1);
    expect(second.commit).toHaveBeenCalledTimes(1);
    expect(second.truncate).toHaveBeenCalledTimes(1);
    expect(second.markReady).toHaveBeenCalledTimes(1);

    disconnectSecond();
    expect(() => feed.finish()).toThrow('Store sync feed is not connected');
  });
});
