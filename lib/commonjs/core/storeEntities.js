"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createRowCleaner = exports.createEntityPlane = void 0;
var _db = require("@tanstack/db");
var _serialize = require("./serialize.js");
var _diagnostics = require("./diagnostics.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _storeSync = require("./storeSync.js");
var _storeUpsertResolver = require("./storeUpsertResolver.js");
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
const DELETED = Symbol('store-row-deleted');
const isStoredRow = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && (0, _normalizeHelpers.isNonEmptyString)(value.id);
const isTombstoneRecord = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && Object.entries(value).every(([id, tombstone]) => (0, _normalizeHelpers.isNonEmptyString)(id) && (0, _normalizeHelpers.isNonArrayRecord)(tombstone) && (0, _normalizeHelpers.isNonNegativeSafeInteger)(tombstone.at));
const createRowCleaner = (cleanRows = new WeakMap()) => {
  return enriched => {
    const cached = cleanRows.get(enriched);
    if (cached) return cached;
    const clean = Object.fromEntries(Object.entries(enriched).filter(([key]) => !key.startsWith('$')));
    cleanRows.set(enriched, clean);
    return clean;
  };
};
exports.createRowCleaner = createRowCleaner;
const createEntityPlane = options => {
  const {
    modelId,
    storeId,
    now,
    storage,
    prefix
  } = options;
  const {
    previewUpsert
  } = (0, _storeUpsertResolver.createUpsertResolver)(options);
  const entityFeed = new _storeSync.SyncFeed();
  const entities = (0, _db.createCollection)({
    ..._storeSync.OWNED_COLLECTION_LIFETIME,
    id: `dblayer-${modelId}-entities-${storeId}`,
    getKey: row => row.id,
    startSync: true,
    sync: {
      sync: entityFeed.sync
    }
  });
  entities.createIndex(row => row.id, {
    indexType: _db.BasicIndex
  });

  /** Enriched-to-clean row cache: collection reads return virtual-prop copies; our written row objects stay the canonical identities. */
  const cleanRows = new WeakMap();
  const buffer = new Map();
  let bufferQueued = false;
  let batchUndo = null;
  const tombstones = new Map();
  const dirty = new Map();
  let tombstonesDirty = false;
  const rowKey = id => (0, _serialize.compositeStorageKey)(prefix(), 'row', modelId, id);
  const rowsPrefix = () => (0, _serialize.compositeStorageKey)(prefix(), 'row', modelId);
  const tombstonesKey = () => (0, _serialize.compositeStorageKey)(prefix(), 'tombstones', modelId);
  const cleanOf = createRowCleaner(cleanRows);
  const readCommitted = id => {
    const enriched = entities.get(id);
    return enriched === undefined ? undefined : cleanOf(enriched);
  };
  const flushBuffer = () => {
    bufferQueued = false;
    batchUndo = null;
    const written = [];
    entityFeed.start();
    for (const [id, entry] of buffer) {
      if (entry === DELETED) {
        if (entities.has(id)) entityFeed.pushMessage({
          type: 'delete',
          key: id
        });
        continue;
      }
      entityFeed.pushMessage({
        type: entities.has(id) ? 'update' : 'insert',
        value: entry
      });
      written.push([id, entry]);
    }
    buffer.clear();
    entityFeed.finish();
    for (const [id, row] of written) {
      const enriched = entities.get(id);
      if (enriched) cleanRows.set(enriched, row);
    }
  };
  const abortBuffer = () => {
    bufferQueued = false;
    buffer.clear();
    const undo = batchUndo;
    for (const [id, value] of undo.dirty) {
      if (value === undefined) dirty.delete(id);else dirty.set(id, value);
    }
    for (const [id, value] of undo.tombstones) {
      if (value === undefined) tombstones.delete(id);else tombstones.set(id, value);
    }
    tombstonesDirty = undo.tombstonesDirty;
    batchUndo = null;
  };
  const batchParticipant = {
    flush: flushBuffer,
    abort: abortBuffer
  };
  const ensureBatchUndo = () => {
    batchUndo ??= {
      dirty: new Map(),
      tombstones: new Map(),
      tombstonesDirty
    };
    return batchUndo;
  };
  const noteDirtyBeforeChange = id => {
    if (!(0, _storeSync.isInApplyBatch)()) return;
    const undo = ensureBatchUndo();
    if (!undo.dirty.has(id)) undo.dirty.set(id, dirty.get(id));
  };
  const noteTombstoneBeforeChange = id => {
    if (!(0, _storeSync.isInApplyBatch)()) return;
    const undo = ensureBatchUndo();
    if (!undo.tombstones.has(id)) undo.tombstones.set(id, tombstones.get(id));
  };
  const bufferWrite = (id, entry) => {
    buffer.set(id, entry);
    if ((0, _storeSync.isInApplyBatch)()) {
      ensureBatchUndo();
      if (!bufferQueued) {
        bufferQueued = true;
        (0, _storeSync.enqueueBatchParticipant)(batchParticipant);
      }
      return;
    }
    flushBuffer();
  };
  const prune = () => {
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
      (0, _diagnostics.noteDataLoss)('tombstone-expiry', modelId, pruned);
    }
    return pruned;
  };
  const read = id => {
    (0, _storeSync.assertStoreReadable)();
    const key = String(id);
    const buffered = buffer.get(key);
    if (buffered !== undefined) return buffered === DELETED ? undefined : buffered;
    return readCommitted(key);
  };
  const put = incoming => {
    let row = incoming;
    const id = String(row.id);
    if (row.id !== id) row = {
      ...row,
      id
    };
    const previous = read(id);
    if (previous === row) return {
      changedFields: []
    };
    const changedFields = previous ? (0, _storeUpsertResolver.diffTopLevelFields)(previous, row) : null;
    if (changedFields !== null && changedFields.length === 0) return {
      changedFields
    };
    if (previous && changedFields !== null && (0, _storeUpsertResolver.isSerializedNoop)(previous, row, changedFields)) {
      (0, _diagnostics.noteEntityUpsertGuardHit)();
      return {
        changedFields: []
      };
    }
    bufferWrite(id, row);
    noteDirtyBeforeChange(id);
    dirty.set(id, 'set');
    if (tombstones.has(id)) {
      noteTombstoneBeforeChange(id);
      tombstones.delete(id);
      tombstonesDirty = true;
    }
    return {
      changedFields
    };
  };
  return {
    entities,
    readCommitted,
    read,
    values: () => {
      (0, _storeSync.assertStoreReadable)();
      const rows = [];
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
      return rows;
    },
    previewUpsert,
    put,
    upsert: (incoming, upsertOptions = {}) => {
      const previous = read(String(incoming.id));
      const prepared = previewUpsert(incoming, {
        previous,
        mergeBase: upsertOptions.mergeBase,
        ctx: upsertOptions.ctx
      });
      if (prepared.changedFields !== null && prepared.changedFields.length === 0) return {
        changedFields: prepared.changedFields
      };
      return put(prepared.row);
    },
    destroy: (id, destroyOptions = {}) => {
      id = String(id);
      bufferWrite(id, DELETED);
      noteDirtyBeforeChange(id);
      if (destroyOptions.tombstone !== false) {
        noteTombstoneBeforeChange(id);
        tombstones.set(id, {
          at: now()
        }); // Preserve delete-before-create protection through the tombstone and defineModel's isTombstoned gate within the TTL.
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
      const entries = [];
      for (const [id, op] of dirty) {
        const row = read(id);
        entries.push({
          key: rowKey(id),
          value: op === 'set' && row ? (0, _persistenceCodec.encodePersistence)(row) : null
        });
      }
      if (tombstonesDirty) {
        entries.push({
          key: tombstonesKey(),
          value: tombstones.size > 0 ? (0, _persistenceCodec.encodePersistence)(Object.fromEntries(tombstones)) : null
        });
      }
      return entries;
    },
    ackPersist: () => {
      dirty.clear();
      tombstonesDirty = false;
    },
    hydrate: () => {
      (0, _storeSync.removeBatchParticipant)(batchParticipant);
      buffer.clear();
      bufferQueued = false;
      batchUndo = null;
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      const loaded = [];
      for (const fullKey of storage.keys(rowsPrefix())) {
        const raw = storage.get(fullKey);
        if (!raw) continue;
        const row = (0, _persistenceCodec.decodeSupportedPersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isStoredRow);
        const keyParts = (0, _serialize.parseCompositeKey)(fullKey.slice(rowsPrefix().length));
        const keyId = keyParts?.length === 1 ? keyParts[0] : undefined;
        if (row && keyId === row.id) {
          loaded.push(row);
        } else {
          storage.set([{
            key: fullKey,
            value: null
          }]);
          (0, _diagnostics.noteDataLoss)('corrupt-row', modelId, 1);
        }
      }
      entityFeed.start();
      entityFeed.truncate();
      for (const row of loaded) entityFeed.pushMessage({
        type: 'insert',
        value: row
      });
      entityFeed.finish();
      for (const row of loaded) {
        const enriched = entities.get(row.id);
        if (enriched) cleanRows.set(enriched, row);
      }
      const rawTombstones = storage.get(tombstonesKey());
      if (rawTombstones) {
        const persisted = (0, _persistenceCodec.decodeSupportedPersistence)(rawTombstones, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isTombstoneRecord);
        if (persisted) {
          for (const [id, tombstone] of Object.entries(persisted)) tombstones.set(id, tombstone);
        } else {
          storage.set([{
            key: tombstonesKey(),
            value: null
          }]);
          (0, _diagnostics.noteDataLoss)('corrupt-tombstones', modelId, 1);
        }
      }
    },
    reset: () => {
      (0, _storeSync.removeBatchParticipant)(batchParticipant);
      buffer.clear();
      bufferQueued = false;
      batchUndo = null;
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      entityFeed.start();
      entityFeed.truncate();
      entityFeed.finish();
    },
    markReady: () => {
      entityFeed.markReady();
    },
    dispose: () => {
      (0, _storeSync.removeBatchParticipant)(batchParticipant);
      batchUndo = null;
    }
  };
};
exports.createEntityPlane = createEntityPlane;
//# sourceMappingURL=storeEntities.js.map