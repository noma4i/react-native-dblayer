import { BasicIndex, createCollection, createLiveQueryCollection, eq, type ChangeMessageOrDeleteKeyMessage } from '@tanstack/db';
import { stableSerialize } from './serialize';
import { noteDataLoss, noteEntityUpsertGuardHit } from './diagnostics';
import type { IncrementalCommitBatch, ModelStore, StoragePlane, StoreMembershipRow, StoreScopeChange, StoreScopeCollection, StoreScopeSyncChange, StoreScopeSyncSource, WriteCtx } from '../types';

type StoreRecord = { id: string } & Record<string, unknown>;

type SyncMethods<T extends object> = {
  begin: () => void;
  write: (message: ChangeMessageOrDeleteKeyMessage<T, string>) => void;
  commit: () => void;
  markReady: () => void;
  truncate: () => void;
};

class SyncFeed<T extends object> {
  private methods: SyncMethods<T> | null = null;

  sync = (methods: SyncMethods<T>): (() => void) => {
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

  private requireMethods(): SyncMethods<T> {
    if (!this.methods) throw new Error('Store sync feed is not connected');
    return this.methods;
  }
}

const membershipKey = (scopeKey: string, entityId: string): string => `${scopeKey}:${entityId}`;
const rankAlphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const fractionalOrderKey = (lower: string | undefined, upper: string | undefined): string => {
  let prefix = '';
  for (let index = 0; ; index += 1) {
    const lowerCharacter = lower?.[index] ?? rankAlphabet[0]!;
    const upperCharacter = upper?.[index] ?? rankAlphabet.at(-1)!;
    if (lowerCharacter === upperCharacter) {
      prefix += lowerCharacter;
      continue;
    }
    const lowerIndex = rankAlphabet.indexOf(lowerCharacter);
    const upperIndex = rankAlphabet.indexOf(upperCharacter);
    if (lowerIndex < 0 || upperIndex < 0 || lowerIndex > upperIndex) throw new Error('Invalid fractional order bounds');
    if (upperIndex - lowerIndex > 1) return `${prefix}${rankAlphabet[Math.floor((lowerIndex + upperIndex) / 2)]!}`;
    return `${prefix}${lowerCharacter}${lower?.slice(index + 1) ?? ''}${rankAlphabet[Math.floor(rankAlphabet.length / 2)]!}`;
  }
};

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

type Tombstone = { at: number };

const diffTopLevelFields = (previous: StoreRecord, next: StoreRecord): string[] => {
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

/** Store factories are a definition registry (registered at defineModel time, replaced per generation); active stores die on reset. */
const storeFactories = new Map<string, () => ModelStore<StoreRecord>>();
const activeStores = new Map<string, ModelStore<StoreRecord>>();
let storeSequence = 0;
let storeScopeCollectionCount = 0;
let applyBatchDepth = 0;
const pendingBatchFlushes = new Set<() => void>();

(globalThis as Record<string, unknown>).__DBLAYER_STORE_SCOPE_COLLECTIONS__ = {
  count: (): number => storeScopeCollectionCount
};

export const registerModelStoreFactory = <T extends StoreRecord>(modelId: string, factory: () => ModelStore<T>): void => {
  storeFactories.set(modelId, factory as () => ModelStore<StoreRecord>);
};

const ensureModelStore = (modelId: string): ModelStore<StoreRecord> => {
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
 * one consistent tick instead of per-row churn. Flushing in `finally` deliberately preserves the
 * partial-application semantics of a mid-batch failure.
 */
export const runInApplyBatch = <T>(run: () => T): T => {
  applyBatchDepth += 1;
  try {
    return run();
  } finally {
    applyBatchDepth -= 1;
    if (applyBatchDepth === 0) {
      const flushes = [...pendingBatchFlushes];
      pendingBatchFlushes.clear();
      for (const flush of flushes) flush();
    }
  }
};

export const createModelStore = <T extends StoreRecord>(options: {
  modelId: string;
  now: () => number;
  storage: StoragePlane;
  prefix: () => string;
  applyWriteGate: (previous: T, incoming: T, ctx: WriteCtx) => T;
  ownedFields?: (rowId: string, excludeOperationId?: string) => ReadonlySet<string>;
}): ModelStore<T> => {
  const { modelId, now, storage, prefix, ownedFields } = options;
  const applyWriteGate = options.applyWriteGate as (previous: StoreRecord, incoming: StoreRecord, ctx: WriteCtx) => StoreRecord;
  const storeId = storeSequence += 1;
  const entityFeed = new SyncFeed<StoreRecord>();
  const membershipFeed = new SyncFeed<StoreMembershipRow>();
  const entities = createCollection<StoreRecord>({
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
  const membershipsByScope = memberships.createIndex(row => row.scopeKey, { indexType: BasicIndex });

  /** Enriched-to-clean row cache: collection reads return virtual-prop copies; our written row objects stay the canonical identities. */
  const cleanRows = new WeakMap<object, StoreRecord>();
  const buffer = new Map<string, StoreRecord | typeof DELETED>();
  let bufferQueued = false;
  const tombstones = new Map<string, Tombstone>();
  const dirty = new Map<string, 'set' | 'delete'>();
  let tombstonesDirty = false;
  let ready = false;
  const rowKey = (id: string) => `${prefix()}row:${modelId}:${id}`;
  const rowsPrefix = () => `${prefix()}row:${modelId}:`;
  const tombstonesKey = () => `${prefix()}tombstones:${modelId}`;

  const cleanOf = (enriched: object): StoreRecord => {
    const cached = cleanRows.get(enriched);
    if (cached) return cached;
    const clean = Object.fromEntries(Object.entries(enriched).filter(([key]) => !key.startsWith('$'))) as StoreRecord;
    cleanRows.set(enriched, clean);
    return clean;
  };

  const readCommitted = (id: string): StoreRecord | undefined => {
    const enriched = entities.get(id);
    return enriched === undefined ? undefined : cleanOf(enriched);
  };

  const flushBuffer = (): void => {
    bufferQueued = false;
    if (buffer.size === 0) return;
    const written: Array<[string, StoreRecord]> = [];
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

  const bufferWrite = (id: string, entry: StoreRecord | typeof DELETED): void => {
    buffer.set(id, entry);
    if (applyBatchDepth > 0) {
      if (!bufferQueued) {
        bufferQueued = true;
        pendingBatchFlushes.add(flushBuffer);
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

  const read = (id: string): StoreRecord | undefined => {
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
      query: q => q
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
    membershipFeed.start();
    for (const message of messages) membershipFeed.pushMessage(message);
    membershipFeed.finish();
  };

  const membershipUpsertsWithOrder = (appendIds: readonly string[], detachIds: ReadonlySet<string>, scopeKey: string, scopeOrder: readonly string[]): Array<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>> => {
    const pendingIds = new Set(appendIds);
    const ranks = new Map(
      scopeMembers(scopeKey)
        .filter(row => !detachIds.has(row.entityId) && !pendingIds.has(row.entityId))
        .map(row => [row.entityId, row.orderKey] as const)
    );
    const upserts: Array<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>> = [];
    for (let index = 0; index < scopeOrder.length; index += 1) {
      const entityId = scopeOrder[index]!;
      if (!pendingIds.has(entityId)) continue;
      const lower = scopeOrder.slice(0, index).reverse().map(id => ranks.get(id)).find(Boolean);
      const upper = scopeOrder.slice(index + 1).map(id => ranks.get(id)).find(Boolean);
      const orderKey = fractionalOrderKey(lower, upper);
      ranks.set(entityId, orderKey);
      const value = { scopeKey, entityId, orderKey };
      upserts.push({ type: memberships.has(membershipKey(scopeKey, entityId)) ? 'update' : 'insert', value });
    }
    return upserts;
  };

  const replaceScope = (scopeKey: string, entityIds: readonly string[]): void => {
    const nextIds = new Set(entityIds);
    const deletes: Array<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>> = scopeMembers(scopeKey)
      .filter(row => !nextIds.has(row.entityId))
      .map(row => ({ type: 'delete', key: membershipKey(scopeKey, row.entityId) }));
    let previousOrderKey: string | undefined;
    const upserts = entityIds.map((entityId): ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string> => {
      previousOrderKey = fractionalOrderKey(previousOrderKey, undefined);
      const value = { scopeKey, entityId, orderKey: previousOrderKey };
      return { type: memberships.has(membershipKey(scopeKey, entityId)) ? 'update' : 'insert', value };
    });
    writeMemberships([...deletes, ...upserts]);
  };

  const store: ModelStore<T> = {
    read: id => read(id) as T | undefined,
    values: () => {
      const rows: StoreRecord[] = [];
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
    upsert: (incoming, upsertOptions = {}) => {
      let row: StoreRecord = incoming;
      const id = String(row.id);
      if (row.id !== id) row = { ...row, id };
      const previous = read(row.id);
      const mergePrevious = previous ?? upsertOptions.mergeBase;
      if (previous === row) return { changedFields: [] };
      const ctx = upsertOptions.ctx ?? { origin: 'snapshot' as const };
      if (mergePrevious && ctx.origin !== 'replace' && ctx.operationId === undefined && ownedFields) {
        const owned = ownedFields(row.id, ctx.operationId);
        if (owned.size > 0) {
          let overlaid: StoreRecord | undefined;
          for (const field of owned) {
            if (!(field in mergePrevious)) continue;
            overlaid ??= { ...row };
            overlaid[field] = (mergePrevious as StoreRecord)[field];
          }
          row = overlaid ?? row;
        }
      }
      if (mergePrevious) row = applyWriteGate(mergePrevious, row, ctx);
      const changedFields = previous ? diffTopLevelFields(previous, row) : null;
      if (changedFields !== null && changedFields.length === 0) return { changedFields };
      if (previous && changedFields !== null && changedFields.every(field => stableSerialize(previous[field]) === stableSerialize(row[field]))) {
        noteEntityUpsertGuardHit();
        return { changedFields: [] };
      }
      bufferWrite(row.id, row);
      dirty.set(row.id, 'set');
      if (tombstones.delete(row.id)) {
        tombstonesDirty = true;
      }
      return { changedFields };
    },
    destroy: (id, destroyOptions = {}) => {
      id = String(id);
      bufferWrite(id, DELETED);
      if (destroyOptions.tombstone !== false) tombstones.set(id, { at: now() }); // Preserve delete-before-create protection through the tombstone and defineModel's isTombstoned gate within the TTL.
      dirty.set(id, 'delete');
      if (destroyOptions.tombstone !== false) tombstonesDirty = true;
    },
    evict: id => {
      id = String(id);
      if (read(id) === undefined) return false;
      bufferWrite(id, DELETED);
      dirty.set(id, 'delete');
      return true;
    },
    isTombstoned: id => tombstones.has(String(id)),
    pruneTombstones: prune,
    persistEntries: () => {
      prune();
      const entries: Array<{ key: string; value: string | null }> = [];
      for (const [id, op] of dirty) {
        entries.push({ key: rowKey(id), value: op === 'set' ? JSON.stringify(read(id)) : null });
      }
      if (tombstonesDirty) {
        entries.push({ key: tombstonesKey(), value: tombstones.size > 0 ? JSON.stringify(Object.fromEntries(tombstones)) : null });
      }
      return entries;
    },
    ackPersist: () => {
      dirty.clear();
      tombstonesDirty = false;
    },
    hydrate: () => {
      buffer.clear();
      bufferQueued = false;
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      const loaded: StoreRecord[] = [];
      for (const fullKey of storage.keys(rowsPrefix())) {
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          const row = JSON.parse(raw) as StoreRecord;
          if (typeof row.id !== 'string') row.id = String(row.id);
          loaded.push(row);
        } catch {
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
        try {
          for (const [id, tombstone] of Object.entries(JSON.parse(rawTombstones) as Record<string, Tombstone>)) tombstones.set(id, tombstone);
        } catch {
          storage.set([{ key: tombstonesKey(), value: null }]);
          noteDataLoss('corrupt-tombstones', modelId, 1);
        }
      }
    },
    reset: () => {
      buffer.clear();
      bufferQueued = false;
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
      toArray: () => (ready ? [...getScopeCollection(scopeKey).collection.toArray] : []),
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
    replaceScope,
    applyScopeChanges: (changes, rowChanges, source) => {
      for (const change of changes) {
        const orderChanged = rowChanges.some(row => source.scopeOrderAffected(change.scopeKey, row.id, row.fields));
        if (change.rebuild === true || orderChanged) {
          replaceScope(change.scopeKey, source.readScopeOrder(change.scopeKey));
          continue;
        }
        const appendIds = [...new Set([...(change.appendIds ?? []), ...(change.appendEntries ?? []).map(entry => entry.id)])];
        const detachIds = new Set(change.detachIds ?? []);
        const deletes: Array<ChangeMessageOrDeleteKeyMessage<StoreMembershipRow, string>> = [...detachIds].map(entityId => ({ type: 'delete', key: membershipKey(change.scopeKey, entityId) }));
        const upserts = appendIds.length > 0 ? membershipUpsertsWithOrder(appendIds, detachIds, change.scopeKey, source.readScopeOrder(change.scopeKey)) : [];
        writeMemberships([...deletes, ...upserts]);
      }
    },
    markReady: () => {
      entityFeed.markReady();
      membershipFeed.markReady();
      ready = true;
    },
    dispose: () => {
      for (const entry of scopeCollections.values()) void entry.collection.cleanup();
      storeScopeCollectionCount -= scopeCollections.size;
      scopeCollections.clear();
      if (activeStores.get(modelId) === store) activeStores.delete(modelId);
    }
  };
  activeStores.set(modelId, store as ModelStore<StoreRecord>);
  return store;
};

/** Project this commit batch's scope changes into the membership collections (rows are already in the entity collections). */
export const syncStoreScopes = (batch: IncrementalCommitBatch, getSource: (model: string) => StoreScopeSyncSource, readyAfterApply = false): void => {
  const models = new Set([...batch.rows.map(change => change.model), ...batch.scopes.map(change => change.model), ...(batch.scopeChanges ?? []).map(change => change.model)]);
  for (const model of models) {
    const source = getSource(model);
    const store = ensureModelStore(model);
    const detailedScopes = batch.scopeChanges ?? [];
    const scopeByKey = new Map<string, StoreScopeSyncChange>();
    for (const scope of batch.scopes.filter(change => change.model === model)) {
      scopeByKey.set(scope.scopeKey, detailedScopes.find(detail => detail.model === model && detail.scopeKey === scope.scopeKey) ?? scope);
    }
    for (const scope of detailedScopes.filter(change => change.model === model)) scopeByKey.set(scope.scopeKey, scope);
    store.applyScopeChanges([...scopeByKey.values()], batch.rows.filter(row => row.model === model), source);
    if (readyAfterApply) store.markReady();
  }
};

/** Boot-time projection: rebuild every persisted scope's membership rows from the hydrated stores. */
export const hydrateStoreScopes = (sources: ReadonlyArray<readonly [string, StoreScopeSyncSource & { readAllScopeKeys(): string[] }]>): void => {
  for (const [model, source] of sources) {
    const store = ensureModelStore(model);
    for (const scopeKey of source.readAllScopeKeys()) store.replaceScope(scopeKey, source.readScopeOrder(scopeKey));
  }
};

export const markStoresReady = (): void => {
  for (const store of activeStores.values()) store.markReady();
};

export const resetStores = (): void => {
  for (const store of [...activeStores.values()]) store.dispose();
  activeStores.clear();
};

export const storeScopeCollection = (model: string, scopeKey: string): StoreScopeCollection => ensureModelStore(model).scopeCollection(scopeKey);
