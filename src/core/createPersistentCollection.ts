import { createCollection, createTransaction } from '@tanstack/db';
import type { CollectionModel, CreateCollectionModelConfig, PersistentCollection, PersistentMutationTransaction } from '../types';
import { createCollectionModel } from './createCollectionModel';
import { mmkvCollectionOptions } from './mmkvCollectionOptions';
import { clearAllCollections, registerPersistentCollectionMutationAcceptor } from './registry';

/**
 * Create a persistent TanStack DB collection backed by the configured storage adapter.
 * @param config Collection id used as the storage key prefix.
 * @returns Persistent collection adapter used by models.
 */
export const createPersistentCollection = <T extends { id: string }>(config: { id: string }): PersistentCollection<T> => {
  const collection = createCollection(
    mmkvCollectionOptions<T, string>({
      id: config.id,
      getKey: (item: T) => item.id
    })
  );

  collection.startSyncImmediate();
  const acceptMutations = (transaction: PersistentMutationTransaction): void => {
    collection.utils.acceptMutations(transaction as Parameters<typeof collection.utils.acceptMutations>[0]);
  };
  registerPersistentCollectionMutationAcceptor(config.id, acceptMutations);
  clearAllCollections.register(() => {
    const ids = [...collection.state.keys()];
    if (ids.length === 0) return;
    const tx = createTransaction({
      mutationFn: ({ transaction }) => {
        acceptMutations(transaction as PersistentMutationTransaction);
        return Promise.resolve();
      }
    });
    tx.mutate(() => {
      for (const id of ids) {
        collection.delete(id);
      }
    });
  });

  const tryUpdate = (id: string, updater: (draft: T) => void): boolean => {
    try {
      collection.update(id, draft => {
        updater(draft as T);
      });
      return true;
    } catch {
      return false;
    }
  };

  const tryDelete = (id: string): boolean => {
    try {
      collection.delete(id);
      return true;
    } catch {
      return false;
    }
  };

  return {
    id: config.id,
    get: (id: string) => collection.state.get(id),
    has: (id: string) => collection.state.has(id),
    insert: (item: T) => {
      if (
        !tryUpdate(item.id, draft => {
          Object.assign(draft, item);
        })
      ) {
        collection.insert(item);
      }
    },
    update: (id: string, updater: (draft: T) => void) => {
      tryUpdate(id, updater);
    },
    delete: (id: string) => {
      tryDelete(id);
    },
    keys: () => collection.state.keys(),
    values: () => collection.state.values(),
    acceptMutations,
    get size() {
      return collection.state.size;
    },
    get _collection() {
      return collection;
    }
  };
};

/**
 * Define a persistent, reactive model with a normalizer.
 * @param config Model id, name, normalizer, freshness, merge, replace, and sort options.
 * @returns Collection model for snapshot reads, reactive hooks, and writes.
 *
 * @example
 * const UserModel = defineModel<UserInput, User>({
 *   id: 'users',
 *   name: 'UserModel',
 *   normalize: user => ({ id: user.id, name: user.name, updatedAt: user.updatedAt })
 * });
 */
export const defineModel = <TInput, TStored extends { id: string; updatedAt?: string | null }, TExt extends Record<string, unknown> = {}>(
  config: Omit<CreateCollectionModelConfig<TInput, TStored, TExt>, 'collection'> & {
    /** Collection id and storage-key prefix; unique per app. */
    id: string;
  }
): CollectionModel<TInput, TStored> & TExt => {
  const { id, ...modelConfig } = config;
  return createCollectionModel<TInput, TStored, TExt>({
    ...modelConfig,
    collection: createPersistentCollection<TStored>({ id })
  });
};
