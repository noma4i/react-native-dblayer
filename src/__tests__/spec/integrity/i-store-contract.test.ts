import { createModelStore, runInApplyBatch } from '../../../core/store';
import { createMemoryPlane } from '../helpers/harness';

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

const scopeSource = (order: () => string[], affected = false) => ({
  readScopeOrder: () => order(),
  scopeOrderAffected: () => affected
});

describe('model store', () => {
  it('lands an inserted row into a live scope as one delta change at 300 and 3000 rows', () => {
    const measure = (size: number): { changes: number; position: number } => {
      const store = buildStore();
      const ids = Array.from({ length: size }, (_, index) => `row-${index}`);
      for (const id of ids) store.upsert({ id });
      store.replaceScope('scope-1', ids);
      store.markReady();
      const scope = store.scopeCollection('scope-1');
      const seen: unknown[] = [];
      const unsubscribe = scope.subscribe(changes => seen.push(...changes));

      const insertedId = 'row-inserted';
      ids.splice(Math.floor(size / 2), 0, insertedId);
      store.upsert({ id: insertedId });
      store.applyScopeChanges([{ scopeKey: 'scope-1', appendIds: [insertedId] }], [{ id: insertedId, fields: null }], scopeSource(() => ids));

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
    store.replaceScope('scope-1', ['row-1']);

    expect(store.scopeCollection('scope-1').toArray()).toEqual([]);

    store.markReady();

    expect(store.scopeCollection('scope-1').toArray()).toMatchObject([{ id: 'row-1', label: 'first' }]);
  });

  it('serves buffered same-batch reads while the live scope holds the pre-batch value', () => {
    const store = buildStore();
    store.upsert({ id: 'seed', label: 'before' });
    store.replaceScope('scope-1', ['seed']);
    store.markReady();
    const scope = store.scopeCollection('scope-1');
    expect(scope.toArray()).toMatchObject([{ id: 'seed', label: 'before' }]);

    runInApplyBatch(() => {
      store.upsert({ id: 'seed', label: 'after' });
      store.upsert({ id: 'row-1', label: 'buffered' });
      expect(store.read('seed')).toMatchObject({ label: 'after' });
      expect(store.read('row-1')).toMatchObject({ id: 'row-1', label: 'buffered' });
      expect(store.values().map(row => row.id).sort()).toEqual(['row-1', 'seed']);
      expect(scope.toArray()).toMatchObject([{ id: 'seed', label: 'before' }]);
    });

    expect(store.read('seed')).toMatchObject({ label: 'after' });
    expect(scope.toArray()).toMatchObject([{ id: 'seed', label: 'after' }]);
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
    store.replaceScope('scope-1', ['row-1', 'row-2']);
    store.markReady();

    store.destroy('row-1');
    store.applyScopeChanges([{ scopeKey: 'scope-1', detachIds: ['row-1'] }], [], scopeSource(() => ['row-2']));

    expect(store.read('row-1')).toBeUndefined();
    expect(store.read('row-2')).toMatchObject({ id: 'row-2' });
    expect(store.scopeCollection('scope-1').toArray().map(row => row.id)).toEqual(['row-2']);
  });

  it('orders scope rows by membership order key using code points', () => {
    const byCodepoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
    const keys = ['b', 'A', 'a', 'B', 'Ab', 'aB'];
    const codepoint = [...keys].sort(byCodepoint);
    expect(codepoint).not.toEqual([...keys].sort((left, right) => left.localeCompare(right)));

    const store = buildStore();
    for (const key of keys) store.upsert({ id: `row-${key}` });
    store.replaceScope('scope-1', codepoint.map(key => `row-${key}`));
    store.markReady();

    expect(store.scopeCollection('scope-1').toArray().map(row => row.id)).toEqual(codepoint.map(key => `row-${key}`));
  });

  it('serves only memberships of the requested scope', () => {
    const store = buildStore();
    store.upsert({ id: 'scope-1-row' });
    store.upsert({ id: 'scope-2-row' });
    store.replaceScope('scope-1', ['scope-1-row']);
    store.replaceScope('scope-2', ['scope-2-row']);
    store.markReady();

    expect(store.scopeCollection('scope-1').toArray().map(row => row.id)).toEqual(['scope-1-row']);
  });

  it('rebuilds membership order when a changed row affects scope order', () => {
    const store = buildStore();
    store.upsert({ id: 'row-1' });
    store.upsert({ id: 'row-2' });
    store.replaceScope('scope-1', ['row-1', 'row-2']);
    store.markReady();

    store.applyScopeChanges([{ scopeKey: 'scope-1', ids: ['row-1'] }], [{ id: 'row-1', fields: ['rank'] }], scopeSource(() => ['row-2', 'row-1'], true));

    expect(store.scopeCollection('scope-1').toArray().map(row => row.id)).toEqual(['row-2', 'row-1']);
  });
});
