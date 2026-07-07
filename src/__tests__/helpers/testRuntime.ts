import { defineModel, f, setDbStorageAdapter } from '../../index';
import type { DbTransport, StorageAdapter, TransportResult } from '../../types';

export type TodoInput = {
  id: string;
  title: string;
  listId?: string | null;
  done?: boolean;
  updatedAt?: string | null;
};

export type Todo = {
  id: string;
  title: string;
  listId: string | null;
  done: boolean;
  updatedAt?: string | null;
};

export type MemoryStorageAdapter = StorageAdapter & {
  dump: () => Record<string, string>;
};

let modelCounter = 0;
const testCollections: Array<{ cleanup: () => Promise<void> }> = [];

export const inMemoryStorageAdapter = (): MemoryStorageAdapter => {
  const store = new Map<string, string>();
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: key => {
      store.delete(key);
    },
    getAllKeys: () => Array.from(store.keys()),
    clear: () => {
      store.clear();
    },
    eventApi: {
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    dump: () => Object.fromEntries(store)
  };
};

export const installMemoryStorage = (): MemoryStorageAdapter => {
  const storage = inMemoryStorageAdapter();
  setDbStorageAdapter(storage);
  return storage;
};

type LooseTransportHandler = (operation: unknown) => Promise<TransportResult<unknown>>;

export const mockTransport = (handlers: {
  query?: LooseTransportHandler;
  mutation?: LooseTransportHandler;
}): DbTransport => ({
  query:
    (handlers.query as DbTransport['query'] | undefined) ??
    (<TData>() =>
      Promise.resolve({
        data: {} as TData
      })),
  mutation:
    (handlers.mutation as DbTransport['mutation'] | undefined) ??
    (<TData>() =>
      Promise.resolve({
        data: {} as TData
      }))
});

export const createTodoModel = (options?: { id?: string; staleTime?: number; dedupeWindowMs?: number }) => {
  const id = options?.id ?? `test-todos-${modelCounter++}`;
  const model = defineModel<TodoInput, Todo>({
    id,
    name: `TodoModel:${id}`,
    staleTime: options?.staleTime,
    normalize: input => ({
      id: input.id,
      title: input.title,
      listId: input.listId ?? null,
      done: input.done ?? false,
      updatedAt: input.updatedAt ?? null
    }),
    merge: {
      dedupeWindowMs: options?.dedupeWindowMs
    },
    replace: {},
    defaultSort: { field: 'id', direction: 'asc' }
  });
  testCollections.push(model._collection as unknown as { cleanup: () => Promise<void> });
  return model;
};

export const createTodoFieldsModel = (options?: { id?: string; staleTime?: number; dedupeWindowMs?: number }) => {
  const id = options?.id ?? `test-field-todos-${modelCounter++}`;
  const model = defineModel({
    id,
    name: `TodoFieldsModel:${id}`,
    staleTime: options?.staleTime,
    fields: {
      title: f.str(),
      listId: f.str().nullable(),
      done: f.bool().default(false),
      updatedAt: f.str().nullable()
    },
    merge: {
      dedupeWindowMs: options?.dedupeWindowMs
    },
    replace: {},
    defaultSort: { field: 'id', direction: 'asc' }
  });
  testCollections.push(model._collection as unknown as { cleanup: () => Promise<void> });
  return model;
};

export const cleanupTestCollections = async (): Promise<void> => {
  const collections = testCollections.splice(0, testCollections.length);
  await Promise.all(collections.map(collection => collection.cleanup()));
};
