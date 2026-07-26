"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createEntityState = void 0;
var _serialize = require("../serialize.js");
var _diagnostics = require("../diagnostics.js");
var _recovery = require("../recovery.js");
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
const diffTopLevelFields = (previous, next) => {
  const fields = new Set();
  for (const key of Object.keys(next)) {
    if (!Object.is(previous[key], next[key])) fields.add(String(key));
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) fields.add(String(key));
  }
  return [...fields];
};
const createEntityState = options => {
  const {
    modelId,
    now,
    storage,
    prefix,
    applyWriteGate,
    ownedFields
  } = options;
  const rows = new Map();
  const tombstones = new Map();
  const dirty = new Map();
  let tombstonesDirty = false;
  const rowKey = id => `${prefix()}row:${modelId}:${id}`;
  const rowsPrefix = () => `${prefix()}row:${modelId}:`;
  const tombstonesKey = () => `${prefix()}tombstones:${modelId}`;
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
    }
    return pruned;
  };
  return {
    read: id => rows.get(id),
    values: () => [...rows.values()],
    upsert: (row, options = {}) => {
      const previous = rows.get(row.id);
      const mergePrevious = previous ?? options.mergeBase;
      if (previous === row) return {
        changedFields: []
      };
      const ctx = options.ctx ?? {
        origin: 'snapshot'
      };
      if (mergePrevious && ctx.origin !== 'replace' && ctx.operationId === undefined && ownedFields) {
        const owned = ownedFields(row.id, ctx.operationId);
        if (owned.size > 0) {
          let overlaid;
          for (const field of owned) {
            if (!(field in mergePrevious)) continue;
            overlaid ??= {
              ...row
            };
            overlaid[field] = mergePrevious[field];
          }
          row = overlaid ?? row;
        }
      }
      if (mergePrevious && applyWriteGate) {
        const gated = applyWriteGate(mergePrevious, row, ctx);
        if (gated === null) return {
          changedFields: []
        };
        row = gated;
      }
      const changedFields = previous ? diffTopLevelFields(previous, row) : null;
      if (changedFields !== null && changedFields.length === 0) return {
        changedFields
      };
      if (previous && changedFields !== null && changedFields.every(field => (0, _serialize.stableSerialize)(previous[field]) === (0, _serialize.stableSerialize)(row[field]))) {
        (0, _diagnostics.noteEntityUpsertGuardHit)();
        return {
          changedFields: []
        };
      }
      rows.set(row.id, row);
      dirty.set(row.id, 'set');
      if (tombstones.delete(row.id)) {
        tombstonesDirty = true;
      }
      return {
        changedFields
      };
    },
    destroy: (id, options = {}) => {
      rows.delete(id);
      if (options.tombstone !== false) tombstones.set(id, {
        at: now()
      }); // Preserve delete-before-create protection through the tombstone and defineModel's isTombstoned gate within the TTL.
      dirty.set(id, 'delete');
      if (options.tombstone !== false) tombstonesDirty = true;
    },
    evict: id => {
      if (!rows.delete(id)) return false;
      dirty.set(id, 'delete');
      return true;
    },
    isTombstoned: id => tombstones.has(id),
    pruneTombstones: prune,
    persistEntries: () => {
      prune();
      const entries = [];
      for (const [id, op] of dirty) {
        entries.push({
          key: rowKey(id),
          value: op === 'set' ? JSON.stringify(rows.get(id)) : null
        });
      }
      if (tombstonesDirty) {
        entries.push({
          key: tombstonesKey(),
          value: tombstones.size > 0 ? JSON.stringify(Object.fromEntries(tombstones)) : null
        });
      }
      return entries;
    },
    ackPersist: () => {
      dirty.clear();
      tombstonesDirty = false;
    },
    hydrate: () => {
      rows.clear();
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      for (const fullKey of storage.keys(rowsPrefix())) {
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          const row = JSON.parse(raw);
          rows.set(row.id, row);
        } catch {
          throw new _recovery.CorruptionError('row', fullKey);
        }
      }
      const rawTombstones = storage.get(tombstonesKey());
      if (rawTombstones) {
        try {
          for (const [id, tombstone] of Object.entries(JSON.parse(rawTombstones))) tombstones.set(id, tombstone);
        } catch {
          throw new _recovery.CorruptionError('tombstones', tombstonesKey());
        }
      }
    },
    reset: () => {
      rows.clear();
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
    }
  };
};
exports.createEntityState = createEntityState;
//# sourceMappingURL=entityState.js.map