import { act } from 'react';
import { createCollection, createTransaction } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { renderCounted } from '../../__tests__/spec/helpers/harness';

/**
 * Phase-2 PoC (tanstack-first redesign): proves the mutation-side design rows of the plan on the
 * installed @tanstack/db primitives, complementing the server-order spike:
 * 1. optimistic insert -> server confirmation via the custom sync feed -> temp row settles away
 *    natively through the transaction lifecycle (R7/G1 temp/server correlation candidate);
 * 2. a rejected mutationFn rolls the optimistic insert back with no residue;
 * 3. a write-policy seam ABOVE the collection rejects stale writes before they reach the store;
 * 4. transaction.mutations exposes the optimistic payload - the durable ledger can capture it.
 * Duplicates the tiny sync-feed helper from the server-order spike on purpose: both files are
 * research assets deleted in Phase 4, sharing would couple their lifecycles.
 */
type MessageRow = { id: string; threadId: string; body: string; updatedAt: number };
type SyncMessage =
  | { type: 'insert' | 'update'; value: MessageRow }
  | { type: 'delete'; key: string };
type SyncMethods = {
  begin: () => void;
  write: (message: SyncMessage) => void;
  commit: () => void;
  markReady: () => void;
};

class ConfirmFeed {
  private methods: SyncMethods | null = null;

  sync = (methods: SyncMethods): (() => void) => {
    this.methods = methods;
    methods.begin();
    methods.commit();
    methods.markReady();
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };

  apply(operations: readonly SyncMessage[]): void {
    if (!this.methods) throw new Error('Confirm feed is not connected');
    this.methods.begin();
    for (const operation of operations) this.methods.write(operation);
    this.methods.commit();
  }
}

const createPocCollection = (id: string) => {
  const feed = new ConfirmFeed();
  const entities = createCollection<MessageRow>({
    id,
    getKey: row => row.id,
    startSync: true,
    sync: { sync: feed.sync }
  });
  return { feed, entities };
};

describe('TanStack optimistic transaction PoC', () => {
  it('shows the optimistic insert immediately and settles into the server row after confirmation', async () => {
    const { feed, entities } = createPocCollection('poc-optimistic-confirm');
    const temp = { id: 'temp-1', threadId: 'thread-1', body: 'hello', updatedAt: 1 };
    const server = { id: 'server-1', threadId: 'thread-1', body: 'hello', updatedAt: 2 };
    const reader = renderCounted(() => useLiveQuery(entities).data);

    const transaction = createTransaction<MessageRow>({
      mutationFn: async () => {
        feed.apply([{ type: 'insert', value: server }]);
      }
    });
    act(() => {
      transaction.mutate(() => entities.insert(temp));
    });

    expect(reader.result().map(row => row.id)).toEqual(['temp-1']);

    await act(async () => {
      await transaction.isPersisted.promise;
    });

    expect(reader.result().map(row => row.id)).toEqual(['server-1']);
    expect(entities.has('temp-1')).toBe(false);
    reader.unmount();
  });

  it('rolls the optimistic insert back with no residue when mutationFn rejects', async () => {
    const { entities } = createPocCollection('poc-optimistic-rollback');
    const temp = { id: 'temp-1', threadId: 'thread-1', body: 'hello', updatedAt: 1 };
    const reader = renderCounted(() => useLiveQuery(entities).data);

    const transaction = createTransaction<MessageRow>({
      mutationFn: async () => {
        throw new Error('transport rejected');
      }
    });
    act(() => {
      transaction.mutate(() => entities.insert(temp));
    });
    expect(reader.result().map(row => row.id)).toEqual(['temp-1']);

    await act(async () => {
      await expect(transaction.isPersisted.promise).rejects.toThrow('transport rejected');
    });

    expect(reader.result()).toEqual([]);
    expect(entities.has('temp-1')).toBe(false);
    reader.unmount();
  });

  it('lets a write-policy seam above the collection reject a stale write before it reaches the store', () => {
    const { feed, entities } = createPocCollection('poc-write-policy');
    const monotonicUpsert = (incoming: MessageRow): boolean => {
      const existing = entities.get(incoming.id);
      if (existing && existing.updatedAt >= incoming.updatedAt) return false;
      feed.apply([{ type: existing ? 'update' : 'insert', value: incoming }]);
      return true;
    };

    expect(monotonicUpsert({ id: 'row-1', threadId: 'thread-1', body: 'fresh', updatedAt: 5 })).toBe(true);
    expect(monotonicUpsert({ id: 'row-1', threadId: 'thread-1', body: 'stale', updatedAt: 3 })).toBe(false);

    expect(entities.get('row-1')).toMatchObject({ body: 'fresh', updatedAt: 5 });
  });

  it('exposes the optimistic payload on transaction.mutations for durable ledger capture', async () => {
    const { feed, entities } = createPocCollection('poc-ledger-capture');
    const temp = { id: 'temp-1', threadId: 'thread-1', body: 'hello', updatedAt: 1 };
    let capturedInput: MessageRow | null = null;

    const transaction = createTransaction<MessageRow>({
      mutationFn: async ({ transaction: currentTransaction }) => {
        capturedInput = currentTransaction.mutations[0]!.modified as MessageRow;
        feed.apply([{ type: 'insert', value: { ...temp, id: 'server-1', updatedAt: 2 } }]);
      }
    });
    transaction.mutate(() => entities.insert(temp));
    await transaction.isPersisted.promise;

    expect(capturedInput).toMatchObject({ id: 'temp-1', body: 'hello' });
  });
});
