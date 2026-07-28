import { createCollection, type ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';

/**
 * Phase-3 store PoC: visibility and identity semantics of a sync-fed collection, captured as
 * executable facts the primary-store design relies on:
 * 1. uncommitted feed writes are invisible; `commit()` applies synchronously in the same tick;
 * 2. `get()` returns the row enriched with virtual props ($key/$origin/...) as a spread COPY, so
 *    persistence must strip them before JSON round-trips;
 * 3. the enriched row keeps reference identity across reads while the source row is unchanged;
 * 4. change notifications arrive synchronously after commit, and their `type` reflects the
 *    subscriber-visible transition (a write sent as `update` can surface as `insert`), so readers
 *    must treat insert/update uniformly as upserts.
 */
type Row = { id: string; body: string };

type Feed = {
  begin: () => void;
  write: (message: ChangeMessageOrDeleteKeyMessage<Row, string>) => void;
  commit: () => void;
  markReady: () => void;
};

const createFeedCollection = () => {
  let methods: Feed | null = null;
  const collection = createCollection<Row>({
    id: `sync-semantics-${Math.random().toString(36).slice(2)}`,
    getKey: row => row.id,
    startSync: true,
    sync: {
      sync: feedMethods => {
        methods = feedMethods;
        return () => {
          methods = null;
        };
      }
    }
  });
  const feed = (): Feed => {
    if (!methods) throw new Error('feed not connected');
    return methods;
  };
  return { collection, feed };
};

describe('TanStack sync feed semantics PoC', () => {
  it('hides uncommitted writes and applies commit synchronously', () => {
    const { collection, feed } = createFeedCollection();
    feed().begin();
    feed().write({ type: 'insert', value: { id: 'r1', body: 'one' } });
    expect(collection.get('r1')).toBeUndefined();
    feed().commit();
    expect(collection.get('r1')).toMatchObject({ id: 'r1', body: 'one' });

    feed().begin();
    feed().write({ type: 'update', value: { id: 'r1', body: 'two' } });
    expect(collection.get('r1')!.body).toBe('one');
    feed().commit();
    expect(collection.get('r1')!.body).toBe('two');

    feed().begin();
    feed().write({ type: 'delete', key: 'r1' });
    feed().commit();
    expect(collection.get('r1')).toBeUndefined();
    expect(collection.size).toBe(0);
  });

  it('returns rows enriched with virtual props that persistence must strip', () => {
    const { collection, feed } = createFeedCollection();
    feed().begin();
    feed().write({ type: 'insert', value: { id: 'r1', body: 'one' } });
    feed().commit();
    const row = collection.get('r1')! as Row & { $key?: string };
    expect(row.$key).toBe('r1');
    expect(JSON.parse(JSON.stringify(row))).toHaveProperty('$collectionId');
    expect(Object.keys(row).filter(key => !key.startsWith('$'))).toEqual(['id', 'body']);
  });

  it('keeps reference identity for unchanged rows and notifies synchronously with upsert semantics', () => {
    const { collection, feed } = createFeedCollection();
    feed().begin();
    feed().write({ type: 'insert', value: { id: 'a', body: 'stay' } });
    feed().write({ type: 'insert', value: { id: 'b', body: 'move' } });
    feed().commit();
    const untouched = collection.get('a');
    expect(collection.get('a')).toBe(untouched);

    const seen: Array<{ type: string; key: string }> = [];
    const subscription = collection.subscribeChanges(changes => {
      for (const change of changes) seen.push({ type: change.type, key: String(change.key) });
    });
    feed().begin();
    feed().write({ type: 'update', value: { id: 'b', body: 'moved' } });
    feed().commit();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe('b');
    expect(['insert', 'update']).toContain(seen[0]!.type);
    expect(collection.get('a')).toBe(untouched);
    expect(collection.get('b')!.body).toBe('moved');
    subscription.unsubscribe();
  });
});
