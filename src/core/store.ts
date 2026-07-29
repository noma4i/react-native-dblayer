import { BasicIndex, createCollection, createLiveQueryCollection, eq, type ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';
import { compareCodepoints, compositeKey, compositeStorageKey, parseCompositeKey, stableSerialize } from './serialize';
import { noteDataLoss, noteEntityUpsertGuardHit, noteMembershipWrites } from './diagnostics';
import type {
  IncrementalCommitBatch,
  ModelStore,
  RowRecord,
  StoragePlane,
  StoreMembershipRow,
  StoreScopeChange,
  StoreScopeCollection,
  StoreScopeSyncChange,
  StoreSyncMethods,
  Tombstone,
  WriteCtx
} from '../types';
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from './persistenceCodec';
import { isNonArrayRecord, isNonEmptyString, isNonNegativeSafeInteger } from '../utils/normalizeHelpers';

class SyncFeed<T extends object> {
  private methods: StoreSyncMethods<T> | null = null;

  sync = (methods: StoreSyncMethods<T>): (() => void) => {
    this.methods = methods;
    return () => {
      if (this.methods === methods) this.methods = null;
    };
  };

  start(): void {
    this.requireMethods().begin();
  }

  pushMessage(message: ChangeMessageOrDeleteKeyMessage<T, string>): void {
    this.requireMethods().write(message);
  }

  finish(): void {
    this.requireMethods().commit();
  }

  truncate(): void {
    this.requireMethods().truncate();
  }

  markReady(): void {
    this.requireMethods().markReady();
  }

  private requireMethods(): StoreSyncMethods<T> {
    if (!this.methods) throw new Error('Store sync feed is not connected');
    return this.methods;
  }
}

const membershipKey = (scopeKey: string, entityId: string): string => compositeKey(scopeKey, entityId);

/**
 * Tombstone retention tuning. Three tiers, from gentlest to most aggressive:
 * - `TOMBSTONE_TTL_MS`: unconditional max lifetime - any tombstone older than this is pruned
 *   regardless of size, every prune() call.
 * - `TOMBSTONE_CAP` + `TOMBSTONE_MIN_AGE_MS`: normal size enforcement. Once the map exceeds the
 *   cap, prune oldest-first back down to the cap, but ONLY among tombstones already older than
 *   the min-age floor - this protects the delete-before-create race window (see `destroy`'s
 *   comment) from being cut short just because the map happens to be near capacity.
 * - Safety valve (`TOMBSTONE_CAP * 2`): a mass-destroy burst can push the map far past the cap
 *   in one tick, all at `now()` and therefore all younger than `TOMBSTONE_MIN_AGE_MS` - the
 *   normal tier above would then prune nothing and the map would stay oversized until the 24h
 *   TTL catches up. Once size exceeds twice the cap, prune oldest-first straight down to the cap
 *   IGNORING the min-age floor for the overflow: an extreme burst is a bigger memory/storage
 *   risk than the narrow race window the floor exists to protect.
 */
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_MIN_AGE_MS = 10 * 60 * 1000;
const TOMBSTONE_CAP = 10_000;
const TOMBSTONE_OVERFLOW_CAP = TOMBSTONE_CAP * 2;

const diffTopLevelFields = (previous: RowRecord, next: RowRecord): string[] => {
  const fields = new Set<string>();
  for (const key of Object.keys(next)) {
    if (!Object.is(previous[key], next[key])) fields.add(key);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) fields.add(key);
  }
  return [...fields];
};

const DELETED = Symbol('store-row-deleted');

const isStoredRow = (value: unknown): value is RowRecord => isNonArrayRecord(value) && isNonEmptyString(value.id);
const isTombstoneRecord = (value: unknown): value is Record<string, Tombstone> =>
  isNonArrayRecord(value) && Object.entries(value).every(([id, tombstone]) => isNonEmptyString(id) && isNonArrayRecord(tombstone) && isNonNegativeSafeInteger(tombstone.at));

/** Store factories are a definition registry (registered at defineModel time, replaced per generation); active stores die on reset. */
const storeFactories = new Map<string, () => ModelStore<RowRecord>>();
const activeStores = new Map<string, ModelStore<RowRecord>>();
let storeSequence = 0;
let storeScopeCollectionCount = 0;
let applyBatchDepth = 0;
let applyBatchFailed = false;
let storeReadsPoisoned = false;
const pendingBatchFlushes = new Set<{ flush(): void; abort(): void }>();

(globalThis as Record<string, unknown>).__DBLAYER_STORE_SCOPE_COLLECTIONS__ = {
  count: (): number => storeScopeCollectionCount
};

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
 * Run one apply pass with batched collection flushes: every store write inside `run` lands in a
 * per-store transactional buffer (readable through the store immediately) and is committed to the
 * collections as one sync-feed transaction per store when the pass ends, so live queries observe
 * one consistent tick instead of per-row churn. A failure aborts every participating store buffer.
 */
export const runInApplyBatch = <T>(run: () => T): T => {
  applyBatchDepth += 1;
  try {
    return run();
  } catch (error) {
    applyBatchFailed = true;
    throw error;
  } finally {
    applyBatchDepth -= 1;
    if (applyBatchDepth === 0) {
      const flushes = [...pendingBatchFlushes];
      pendingBatchFlushes.clear();
      const failed = applyBatchFailed;
      applyBatchFailed = false;
      for (const entry of flushes) {
        if (failed) entry.abort();
        else entry.flush();
      }
    }
  }
};

export const poisonStoreReads = (): void => {
  storeReadsPoisoned = true;
};

export const restoreStoreReads = (): void => {
  storeReadsPoisoned = false;
};

const assertStoreReadable = (): void => {
  if (storeReadsPoisoned) throw new Error('Database apply state is poisoned');
};

export const createModelStore = <T extends RowRecord>(options: {
  modelId: string;
  now: () => number;
  storage: StoragePlane;
  prefix: () => string;
  applyWriteGate: (previous: T, incoming: T, ctx: WriteCtx) => T;
  ownedFields?: (rowId: string, excludeOperationId?: string) => ReadonlySet<string>;
}): ModelStore<T> => {
  const { modelId, now, storage, prefix, ownedFields } = options;
  const applyWriteGate = options.applyWriteGate as (previous: RowRecord, incoming: RowRecord, ctx: WriteCtx) => RowRecord;
  const storeId = (storeSequence += 1);
  const entityFeed = new SyncFeed<RowRecord>();
  const membershipFeed = new SyncFeed<StoreMembershipRow>();
  const entities = createCollection<RowRecord>({
    id: `dblayer-${modelId}-entities-${storeId}`,
    getKey: row => row.id,
    startSync: true,
    sync: { sync: entityFeed.sync }
  });
  const memberships = createCollection<StoreMembershipRow>({
    id: `dblayer-${modelId}-memberships-${storeId}`,
    getKey: row => membershipKey(row.scopeKey, row.entityId),
    startSync: true,
    sync: { sync: membershipFeed.sync }
  });
  entities.createIndex(row => row.id, { indexType: BasicIndex });
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, { indexType: BasicIndex });

  /** Enriched-to-clean row cache: collection reads return virtual-prop copies; our written row objects stay the canonical identities. */
  const cleanRows = new WeakMap<object, RowRecord>();
  const buffer = new Map<string, RowRecord | typeof DELETED>();
  let bufferQueued = false;
  let batchUndo: {
    dirty: Map<string, 'set' | 'delete' | undefined>;
    tombstones: Map<string, Tombstone | undefined>;
    tombstonesDirty: boolean;
  } | null = null;
  const tombstones = new Map<string, Tombstone>();
  const dirty = new Map<string, 'set' | 'delete'>();
  let tombstonesDirty = false;
  let ready = false;
  const rowKey = (id: string) => compositeStorageKey(prefix(), 'row', modelId, id);
  const rowsPrefix = () => compositeStorageKey(prefix(), 'row', modelId);
  const tombstonesKey = () => compositeStorageKey(prefix(), 'tombstones', modelId);

  const cleanOf = (enriched: object): RowRecord => {
    const cached = cleanRows.get(enriched);
    if (cached) return cached;
    const clean = Object.fromEntries(Object.entries(enriched).filter(([key]) => !key.startsWith('$'))) as RowRecord;
    cleanRows.set(enriched, clean);
    return clean;
  };

  const readCommitted = (id: string): RowRecord | undefined => {
    const enriched = entities.get(id);
    return enriched === undefined ? undefined : cleanOf(enriched);
  };

  const flushBuffer = (): void => {
    bufferQueued = false;
    batchUndo = null;
    if (buffer.size === 0) return;
    const written: Array<[string, RowRecord]> = [];
    entityFeed.start();
    for (const [id, entry] of buffer) {
      if (entry === DELETED) {
        if (entities.has(id)) entityFeed.pushMessage({ type: 'delete', key: id });
        continue;
      }
      entityFeed.pushMessage({ type: entities.has(id) ? 'update' : 'insert', value: entry });
      written.push([id, entry]);
    }
    buffer.clear();
    entityFeed.finish();
    for (const [id, row] of written) {
      const enriched = entities.get(id);
      if (enriched) cleanRows.set(enriched, row);
    }
  };

  const abortBuffer = (): void => {
    bufferQueued = false;
    buffer.clear();
    if (!batchUndo) return;
    for (const [id, value] of batchUndo.dirty) {
      if (value === undefined) dirty.delete(id);
      else dirty.set(id, value);
    }
    for (const [id, value] of batchUndo.tombstones) {
      if (value === undefined) tombstones.delete(id);
      else tombstones.set(id, value);
    }
    tombstonesDirty = batchUndo.tombstonesDirty;
    batchUndo = null;
  };

  const batchParticipant = { flush: flushBuffer, abort: abortBuffer };
  const ensureBatchUndo = (): NonNullable<typeof batchUndo> => {
    batchUndo ??= { dirty: new Map(), tombstones: new Map(), tombstonesDirty };
    return batchUndo;
  };
  const noteDirtyBeforeChange = (id: string): void => {
    if (applyBatchDepth === 0) return;
    const undo = ensureBatchUndo();
    if (!undo.dirty.has(id)) undo.dirty.set(id, dirty.get(id));
  };
  const noteTombstoneBeforeChange = (id: string): void => {
    if (applyBatchDepth === 0) return;
    const undo = ensureBatchUndo();
    if (!undo.tombstones.has(id)) undo.tombstones.set(id, tombstones.get(id));
  };

  const bufferWrite = (id: string, entry: RowRecord | typeof DELETED): void => {
    buffer.set(id, entry);
    if (applyBatchDepth > 0) {
      ensureBatchUndo();
      if (!bufferQueued) {
        bufferQueued = true;
        pendingBatchFlushes.add(batchParticipant);
      }
      return;
    }
    flushBuffer();
  };

  const prune = (): number => {
    const cutoff = now() - TOMBSTONE_TTL_MS;
    const minAge = now() - TOMBSTONE_MIN_AGE_MS;
    let pruned = 0;
    for (const [id, tombstone] of tombstones) {
      if (tombstone.at < cutoff) {
        tombstones.delete(id);
        pruned += 1;
      }
    }
    if (tombstones.size > TOMBSTONE_CAP) {
      const prunable = [...tombstones.entries()].filter(([, tombstone]) => tombstone.at < minAge).sort((a, b) => a[1].at - b[1].at);
      for (const [id] of prunable.slice(0, tombstones.size - TOMBSTONE_CAP)) {
        tombstones.delete(id);
        pruned += 1;
      }
    }
    if (tombstones.size > TOMBSTONE_OVERFLOW_CAP) {
      const overflow = [...tombstones.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of overflow.slice(0, tombstones.size - TOMBSTONE_CAP)) {
        tombstones.delete(id);
        pruned += 1;
      }
    }
    if (pruned > 0) {
      tombstonesDirty = true;
      noteDataLoss('tombstone-expiry', modelId, pruned);
    }
    return pruned;
  };

  const read = (id: string): RowRecord | undefined => {
    assertStoreReadable();
    const key = String(id);
    const buffered = buffer.get(key);
    if (buffered !== undefined) return buffered === DELETED ? undefined : buffered;
    return readCommitted(key);
  };

  const scopeCollections = new Map<string, { collection: ReturnType<typeof buildScopeCollection>; consumers: number }>();
  const buildScopeCollection = (scopeKey: string) =>
    createLiveQueryCollection({
      id: `dblayer-${modelId}-scope-${storeId}-${scopeKey}`,
      startSync: true,
      query: q =>
        q
          .from({ membership: memberships })
          .where(({ membership }) => eq(membership.scopeKey, scopeKey))
          .join({ entity: entities }, ({ membership, entity }) => eq(membership.entityId, entity.id))
          .orderBy(({ membership }) => membership.orderKey, { direction: 'asc', stringSort: 'lexical' })
          .select(({ membership, entity }) => ({ ...entity, orderKey: membership.orderKey })),
      getKey: row => row.$key
    });

  const getScopeCollection = (scopeKey: string) => {
    const existing = scopeCollections.get(scopeKey);
    if (existing) return existing;
    const entry = { collection: buildScopeCollection(scopeKey), consumers: 0 };
    scopeCollections.set(scopeKey, entry);
    storeScopeCollectionCount += 1;
    return entry;
  };

  const releaseScopeCollection = (scopeKey: string, entry: { collection: ReturnType<typeof buildScopeCollection>; consumers: number }): void => {
    entry.consumers -= 1;
    if (entry.consumers !== 0 || scopeCollections.get(scopeKey) !== entry) return;
    scopeCollections.delete(scopeKey);
    storeScopeCollectionCount -= 1;
    void entry.collection.cleanup();
  };

  const scopeMembers = (scopeKey: string): StoreMembershipRow[] =>
    [...membershipsByScope.equalityLookup(scopeKey)].flatMap(key => {
      if (typeof key !== 'string') return [];
      const row = memberships.get(key);
      return row ? [row] : [];
    });

  const writeMemberships = (messages: ReadonlyArray<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>>): void => {
    if (messages.length === 0) return;
    noteMembershipWrites(messages.length);
    membershipFeed.start();
    for (const message of messages) membershipFeed.pushMessage(message);
    membershipFeed.finish();
  };

  /** Project ready-made membership instructions; the store never computes an order key. */
  const projectScopeChange = (change: StoreScopeSyncChange): void => {
    const messages: Array<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>> = [];
    if (change.entries) {
      const current = new Map(scopeMembers(change.scopeKey).map(row => [row.entityId, row.orderKey] as const));
      const nextIds = new Set(change.entries.map(entry => entry.id));
      for (const [entityId] of current) {
        if (!nextIds.has(entityId)) messages.push({ type: 'delete', key: membershipKey(change.scopeKey, entityId) });
      }
      for (const entry of change.entries) {
        const existing = current.get(entry.id);
        if (existing === entry.orderKey) continue;
        messages.push({ type: existing === undefined ? 'insert' : 'update', value: { scopeKey: change.scopeKey, entityId: entry.id, orderKey: entry.orderKey } });
      }
    }
    for (const entityId of change.detachIds ?? []) {
      if (memberships.has(membershipKey(change.scopeKey, entityId))) messages.push({ type: 'delete', key: membershipKey(change.scopeKey, entityId) });
    }
    for (const entry of change.upserts ?? []) {
      const key = membershipKey(change.scopeKey, entry.id);
      const existing = memberships.get(key);
      if (existing?.orderKey === entry.orderKey) continue;
      messages.push({ type: existing === undefined ? 'insert' : 'update', value: { scopeKey: change.scopeKey, entityId: entry.id, orderKey: entry.orderKey } });
    }
    writeMemberships(messages);
  };

  const previewUpsert = (
    incoming: RowRecord,
    upsertOptions: { previous: RowRecord | undefined; mergeBase?: RowRecord; ctx?: WriteCtx }
  ): { row: RowRecord; changedFields: string[] | null } => {
    let row = incoming;
    const id = String(row.id);
    if (row.id !== id) row = { ...row, id };
    const previous = upsertOptions.previous;
    const mergePrevious = previous ?? upsertOptions.mergeBase;
    if (previous === row) return { row, changedFields: [] };
    const ctx = upsertOptions.ctx ?? { origin: 'snapshot' as const };
    if (mergePrevious && ctx.origin !== 'replace' && ctx.operationId === undefined && ownedFields) {
      const owned = ownedFields(row.id, ctx.operationId);
      if (owned.size > 0) {
        let overlaid: RowRecord | undefined;
        for (const field of owned) {
          if (!(field in mergePrevious)) continue;
          overlaid ??= { ...row };
          overlaid[field] = mergePrevious[field];
        }
        row = overlaid ?? row;
      }
    }
    if (mergePrevious) row = applyWriteGate(mergePrevious, row, ctx);
    const changedFields = previous ? diffTopLevelFields(previous, row) : null;
    if (previous && changedFields !== null && changedFields.length > 0 && changedFields.every(field => stableSerialize(previous[field]) === stableSerialize(row[field]))) {
      noteEntityUpsertGuardHit();
      return { row: previous, changedFields: [] };
    }
    return { row, changedFields };
  };

  const put = (incoming: RowRecord): { changedFields: string[] | null } => {
    let row = incoming;
    const id = String(row.id);
    if (row.id !== id) row = { ...row, id };
    const previous = read(id);
    if (previous === row) return { changedFields: [] };
    const changedFields = previous ? diffTopLevelFields(previous, row) : null;
    if (changedFields !== null && changedFields.length === 0) return { changedFields };
    if (previous && changedFields !== null && changedFields.every(field => stableSerialize(previous[field]) === stableSerialize(row[field]))) {
      noteEntityUpsertGuardHit();
      return { changedFields: [] };
    }
    bufferWrite(id, row);
    noteDirtyBeforeChange(id);
    dirty.set(id, 'set');
    if (tombstones.has(id)) {
      noteTombstoneBeforeChange(id);
      tombstones.delete(id);
      tombstonesDirty = true;
    }
    return { changedFields };
  };

  const store: ModelStore<T> = {
    read: id => read(id) as T | undefined,
    values: () => {
      assertStoreReadable();
      const rows: RowRecord[] = [];
      for (const enriched of entities.toArray) {
        const clean = cleanOf(enriched);
        const buffered = buffer.get(clean.id);
        if (buffered === DELETED) continue;
        rows.push(buffered === undefined ? clean : buffered);
      }
      if (buffer.size > 0) {
        for (const [id, entry] of buffer) {
          if (entry !== DELETED && !entities.has(id)) rows.push(entry);
        }
      }
      return rows as T[];
    },
    previewUpsert: (incoming, upsertOptions) =>
      previewUpsert(incoming, upsertOptions as { previous: RowRecord | undefined; mergeBase?: RowRecord; ctx?: WriteCtx }) as {
        row: T;
        changedFields: string[] | null;
      },
    put: incoming => put(incoming),
    upsert: (incoming, upsertOptions = {}) => {
      const previous = read(String(incoming.id));
      const prepared = previewUpsert(incoming, {
        previous,
        mergeBase: upsertOptions.mergeBase,
        ctx: upsertOptions.ctx
      });
      if (prepared.changedFields !== null && prepared.changedFields.length === 0) return { changedFields: prepared.changedFields };
      return put(prepared.row);
    },
    destroy: (id, destroyOptions = {}) => {
      id = String(id);
      bufferWrite(id, DELETED);
      noteDirtyBeforeChange(id);
      if (destroyOptions.tombstone !== false) {
        noteTombstoneBeforeChange(id);
        tombstones.set(id, { at: now() }); // Preserve delete-before-create protection through the tombstone and defineModel's isTombstoned gate within the TTL.
      }
      dirty.set(id, 'delete');
      if (destroyOptions.tombstone !== false) tombstonesDirty = true;
    },
    evict: id => {
      id = String(id);
      if (read(id) === undefined) return false;
      bufferWrite(id, DELETED);
      noteDirtyBeforeChange(id);
      dirty.set(id, 'delete');
      return true;
    },
    isTombstoned: id => tombstones.has(String(id)),
    pruneTombstones: prune,
    persistEntries: () => {
      prune();
      const entries: Array<{ key: string; value: string | null }> = [];
      for (const [id, op] of dirty) {
        const row = read(id);
        entries.push({ key: rowKey(id), value: op === 'set' && row ? encodePersistence(row) : null });
      }
      if (tombstonesDirty) {
        entries.push({ key: tombstonesKey(), value: tombstones.size > 0 ? encodePersistence(Object.fromEntries(tombstones)) : null });
      }
      return entries;
    },
    ackPersist: () => {
      dirty.clear();
      tombstonesDirty = false;
    },
    hydrate: () => {
      pendingBatchFlushes.delete(batchParticipant);
      buffer.clear();
      bufferQueued = false;
      batchUndo = null;
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      const loaded: RowRecord[] = [];
      for (const fullKey of storage.keys(rowsPrefix())) {
        const raw = storage.get(fullKey);
        if (!raw) continue;
        const row = decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, isStoredRow);
        const keyParts = parseCompositeKey(fullKey.slice(rowsPrefix().length));
        const keyId = keyParts?.length === 1 ? keyParts[0] : undefined;
        if (row && keyId === row.id) {
          loaded.push(row);
        } else {
          storage.set([{ key: fullKey, value: null }]);
          noteDataLoss('corrupt-row', modelId, 1);
        }
      }
      entityFeed.start();
      entityFeed.truncate();
      for (const row of loaded) entityFeed.pushMessage({ type: 'insert', value: row });
      entityFeed.finish();
      for (const row of loaded) {
        const enriched = entities.get(row.id);
        if (enriched) cleanRows.set(enriched, row);
      }
      const rawTombstones = storage.get(tombstonesKey());
      if (rawTombstones) {
        const persisted = decodeSupportedPersistence(rawTombstones, PERSISTENCE_SCHEMA_VERSION, isTombstoneRecord);
        if (persisted) {
          for (const [id, tombstone] of Object.entries(persisted)) tombstones.set(id, tombstone);
        } else {
          storage.set([{ key: tombstonesKey(), value: null }]);
          noteDataLoss('corrupt-tombstones', modelId, 1);
        }
      }
    },
    reset: () => {
      pendingBatchFlushes.delete(batchParticipant);
      buffer.clear();
      bufferQueued = false;
      batchUndo = null;
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      entityFeed.start();
      entityFeed.truncate();
      entityFeed.finish();
      membershipFeed.start();
      membershipFeed.truncate();
      membershipFeed.finish();
    },
    scopeCollection: scopeKey => ({
      toArray: () => {
        assertStoreReadable();
        if (!ready) return [];
        const existing = scopeCollections.get(scopeKey);
        if (existing) return [...existing.collection.toArray];
        return scopeMembers(scopeKey)
          .sort((left, right) => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.entityId, right.entityId))
          .flatMap(membership => {
            const entity = readCommitted(membership.entityId);
            return entity ? [{ ...entity, orderKey: membership.orderKey }] : [];
          });
      },
      subscribe: listener => {
        const entry = getScopeCollection(scopeKey);
        entry.consumers += 1;
        const subscription = entry.collection.subscribeChanges(changes => listener(changes as StoreScopeChange[]), { includeInitialState: false });
        return () => {
          subscription.unsubscribe();
          releaseScopeCollection(scopeKey, entry);
        };
      }
    }),
    applyScopeChanges: changes => {
      for (const change of changes) projectScopeChange(change);
    },
    markReady: () => {
      entityFeed.markReady();
      membershipFeed.markReady();
      ready = true;
    },
    dispose: () => {
      pendingBatchFlushes.delete(batchParticipant);
      batchUndo = null;
      for (const entry of scopeCollections.values()) void entry.collection.cleanup();
      storeScopeCollectionCount -= scopeCollections.size;
      scopeCollections.clear();
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
