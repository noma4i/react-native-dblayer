import type { EntityPlane, IncrementalCommitBatch, ModelStore, PreparedUpsert, RowRecord, ScopePlane, StoragePlane, StoreScopeCollection, WriteCtx } from '../types';
import { createEntityPlane } from './storeEntities';
import { restoreStoreReads } from './storeSync';
import { createScopePlane } from './storeScopeCollections';

export { runInApplyBatch, poisonStoreReads, restoreStoreReads } from './storeSync';

/** Store factories are a definition registry (registered at defineModel time, replaced per generation); active stores die on reset. */
const storeFactories = new Map<string, () => ModelStore<RowRecord>>();
const activeStores = new Map<string, ModelStore<RowRecord>>();
let storeSequence = 0;

export const registerModelStoreFactory = <T extends RowRecord>(modelId: string, factory: () => ModelStore<T>): void => {
  storeFactories.set(modelId, factory as () => ModelStore<RowRecord>);
};

const ensureModelStore = (modelId: string): ModelStore<RowRecord> => {
  const active = activeStores.get(modelId);
  if (active) return active;
  const factory = storeFactories.get(modelId);
  if (!factory) throw new Error(`No store registered for model ${modelId}`);
  return factory();
};

/**
 * Per-model primary store facade: composes the entity plane (rows, transactional buffer,
 * tombstones, persistence) with the scope plane (membership collection, live scope collections)
 * into the `ModelStore` contract. Both planes are private to this composition.
 */
export const createModelStore = <T extends RowRecord>(options: {
  modelId: string;
  now: () => number;
  storage: StoragePlane;
  prefix: () => string;
  applyWriteGate: (previous: T, incoming: T, ctx: WriteCtx) => T;
  ownedFields?: (rowId: string, excludeOperationId?: string) => ReadonlySet<string>;
}): ModelStore<T> => {
  const { modelId, now, storage, prefix, ownedFields } = options;
  const storeId = (storeSequence += 1);
  let ready = false;
  const entityPlane: EntityPlane = createEntityPlane({
    modelId,
    storeId,
    now,
    storage,
    prefix,
    applyWriteGate: options.applyWriteGate as (previous: RowRecord, incoming: RowRecord, ctx: WriteCtx) => RowRecord,
    ownedFields
  });
  const scopePlane: ScopePlane = createScopePlane({
    modelId,
    storeId,
    entities: entityPlane.entities,
    readCommitted: entityPlane.readCommitted,
    isReady: () => ready
  });

  const store: ModelStore<T> = {
    read: id => entityPlane.read(id) as T | undefined,
    values: () => entityPlane.values() as T[],
    previewUpsert: (incoming, upsertOptions) =>
      entityPlane.previewUpsert(incoming, upsertOptions as { previous: RowRecord | undefined; mergeBase?: RowRecord; ctx?: WriteCtx }) as PreparedUpsert<T>,
    put: incoming => entityPlane.put(incoming),
    upsert: (incoming, upsertOptions) => entityPlane.upsert(incoming, upsertOptions),
    destroy: (id, destroyOptions) => entityPlane.destroy(id, destroyOptions),
    evict: id => entityPlane.evict(id),
    isTombstoned: id => entityPlane.isTombstoned(id),
    pruneTombstones: () => entityPlane.pruneTombstones(),
    persistEntries: () => entityPlane.persistEntries(),
    ackPersist: () => entityPlane.ackPersist(),
    hydrate: () => entityPlane.hydrate(),
    reset: () => {
      entityPlane.reset();
      scopePlane.reset();
    },
    scopeCollection: scopeKey => scopePlane.scopeCollection(scopeKey),
    applyScopeChanges: changes => scopePlane.applyScopeChanges(changes),
    markReady: () => {
      entityPlane.markReady();
      scopePlane.markReady();
      ready = true;
    },
    dispose: () => {
      entityPlane.dispose();
      scopePlane.dispose();
      if (activeStores.get(modelId) === store) activeStores.delete(modelId);
    }
  };
  activeStores.set(modelId, store as ModelStore<RowRecord>);
  return store;
};

/**
 * THE publish seam: project this batch's scope changes into the membership collections, then
 * publish on the commit bus. Every scope-carrying batch - commit, replay, and GC - goes through
 * here, so a scope-plane mutation can never bypass the store projection.
 */
export const publishProjectedBatch = (bus: { publish(batch: IncrementalCommitBatch): void }, batch: IncrementalCommitBatch, options?: { readyAfterApply?: boolean }): void => {
  const models = new Set([...batch.rows.map(change => change.model), ...batch.scopes.map(change => change.model), ...(batch.scopeChanges ?? []).map(change => change.model)]);
  for (const model of models) {
    const store = ensureModelStore(model);
    store.applyScopeChanges((batch.scopeChanges ?? []).filter(change => change.model === model));
    if (options?.readyAfterApply) store.markReady();
  }
  bus.publish(batch);
};

/** Boot-time projection: rebuild every persisted scope's membership rows straight from persisted entries. */
export const hydrateStoreScopes = (
  sources: ReadonlyArray<readonly [string, { readScopeEntries(scopeKey: string): Array<{ id: string; orderKey: string }>; readAllScopeKeys(): string[] }]>
): void => {
  for (const [model, source] of sources) {
    const store = ensureModelStore(model);
    store.applyScopeChanges(source.readAllScopeKeys().map(scopeKey => ({ scopeKey, entries: source.readScopeEntries(scopeKey) })));
  }
};

export const markStoresReady = (): void => {
  for (const store of activeStores.values()) store.markReady();
};

export const resetStores = (): void => {
  restoreStoreReads();
  for (const store of [...activeStores.values()]) store.dispose();
  activeStores.clear();
};

export const storeScopeCollection = (model: string, scopeKey: string): StoreScopeCollection => ensureModelStore(model).scopeCollection(scopeKey);
