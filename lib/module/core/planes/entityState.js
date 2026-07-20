"use strict";

import { stableSerialize } from "../serialize.js";
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
export const createEntityState = options => {
  const {
    modelId,
    clock,
    now,
    storage,
    prefix,
    mergeGate
  } = options;
  const rows = new Map();
  const writes = new Map();
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
    upsert: row => {
      const previous = rows.get(row.id);
      if (previous === row) return {
        seq: clock.current(),
        changedFields: []
      };
      if (previous && mergeGate) row = mergeGate(previous, row);
      const changedFields = previous ? diffTopLevelFields(previous, row) : null;
      if (changedFields !== null && changedFields.length === 0) return {
        seq: clock.current(),
        changedFields
      };
      if (previous && stableSerialize(previous) === stableSerialize(row)) return {
        seq: clock.current(),
        changedFields: []
      };
      const seq = clock.next();
      rows.set(row.id, row);
      writes.set(row.id, seq);
      dirty.set(row.id, 'set');
      if (tombstones.delete(row.id)) {
        tombstonesDirty = true;
      }
      return {
        seq,
        changedFields
      };
    },
    destroy: (id, options = {}) => {
      const seq = clock.next();
      rows.delete(id);
      writes.delete(id);
      if (options.tombstone !== false) tombstones.set(id, {
        seq,
        at: now()
      }); // Preserve out-of-order delete-before-create protection within the TTL.
      dirty.set(id, 'delete');
      if (options.tombstone !== false) tombstonesDirty = true;
      return seq;
    },
    evict: id => {
      if (!rows.delete(id)) return false;
      writes.delete(id);
      dirty.set(id, 'delete');
      return true;
    },
    isTombstoned: id => tombstones.has(id),
    snapshot: () => clock.current(),
    wasWrittenAfter: (id, capture) => (writes.get(id) ?? 0) > capture,
    wasDestroyedAfter: (id, capture) => (tombstones.get(id)?.seq ?? 0) > capture,
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
      dirty.clear();
      if (tombstonesDirty) {
        entries.push({
          key: tombstonesKey(),
          value: tombstones.size > 0 ? JSON.stringify(Object.fromEntries(tombstones)) : null
        });
        tombstonesDirty = false;
      }
      return entries;
    },
    hydrate: () => {
      rows.clear();
      writes.clear();
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
          storage.set([{
            key: fullKey,
            value: null
          }]);
        }
      }
      const rawTombstones = storage.get(tombstonesKey());
      if (rawTombstones) {
        try {
          for (const [id, tombstone] of Object.entries(JSON.parse(rawTombstones))) tombstones.set(id, tombstone);
        } catch {
          storage.set([{
            key: tombstonesKey(),
            value: null
          }]);
        }
      }
    },
    reset: () => {
      rows.clear();
      writes.clear();
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
    }
  };
};
export const createEntityClock = () => {
  let sequence = 0;
  return {
    next: () => ++sequence,
    current: () => sequence,
    restore: value => {
      sequence = Math.max(sequence, value);
    }
  };
};
//# sourceMappingURL=entityState.js.map