import {
  createCollection,
  createTransaction,
  type Collection,
  type SyncConfig,
} from '@tanstack/db'

/** A stored row accepted by the TanStack collection facade. */
export type StoredRowShape = { id: string } & Record<string, unknown>

/** The synchronous writer callbacks supplied by a TanStack collection sync adapter. */
export type CollectionWriter = Pick<
  Parameters<SyncConfig<StoredRowShape, string>[`sync`]>[0],
  `begin` | `write` | `commit` | `markReady`
>

const writerRegistry = new Map<string, CollectionWriter>()
const collectionRegistry = new Map<string, Collection<StoredRowShape, string>>()

/** Creates an empty, ready TanStack collection for a model identifier. */
export function createModelCollection(modelId: string) {
  const collection = createCollection<StoredRowShape, string>({
    id: modelId,
    getKey: (row) => row.id,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        writerRegistry.set(modelId, { begin, write, commit, markReady })
        begin()
        commit()
        markReady()
      },
    },
  })

  collectionRegistry.set(modelId, collection)
  return collection
}

/** Returns a model collection, creating its ready writer-backed instance when absent. */
export function ensureModelCollection(modelId: string) {
  return collectionRegistry.get(modelId) ?? createModelCollection(modelId)
}

/** Returns the registered synchronous writer for a model identifier. */
export function writerFor(modelId: string): CollectionWriter {
  const writer = writerRegistry.get(modelId)
  if (!writer) {
    throw new Error(`Missing writer for ${modelId}`)
  }
  return writer
}

/** Reports whether a synchronous writer is registered for a model identifier. */
export function hasWriter(modelId: string): boolean {
  return writerRegistry.has(modelId)
}

/** Clears the TanStack collection and writer registries. */
export function resetCollectionRegistry(): void {
  writerRegistry.clear()
  collectionRegistry.clear()
}

/** Runs synchronous writes in one TanStack cross-collection transaction context. */
export function runInWriteBatch<T>(fn: () => T): T {
  let result: T | undefined
  const transaction = createTransaction({
    mutationFn: async () => undefined,
  })

  transaction.mutate(() => {
    result = fn()
  })

  return result as T
}

/** Returns the registered TanStack collection for a model identifier. */
export function collectionFor(modelId: string) {
  const collection = collectionRegistry.get(modelId)
  if (!collection) {
    throw new Error(`Missing collection for ${modelId}`)
  }
  return collection
}
