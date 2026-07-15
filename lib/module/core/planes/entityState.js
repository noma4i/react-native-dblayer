"use strict";

const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_MIN_AGE_MS = 10 * 60 * 1000;
const TOMBSTONE_CAP = 10_000;
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
    prefix
  } = options;
  const rows = new Map();
  const writes = new Map();
  const tombstones = new Map();
  const dirty = new Map();
  let tombstonesDirty = false;
  const rowKey = id => `${prefix()}row:${modelId}:${id}`;
  const rowsPrefix = () => `${prefix()}row:${modelId}:`;
  const legacyRowsKey = () => `${prefix()}rows:${modelId}`;
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
      const seq = clock.next();
      rows.set(row.id, row);
      writes.set(row.id, seq);
      dirty.set(row.id, 'set');
      if (tombstones.delete(row.id)) {
        tombstonesDirty = true;
      }
      return {
        seq,
        changedFields: previous ? diffTopLevelFields(previous, row) : null
      };
    },
    destroy: id => {
      const seq = clock.next();
      rows.delete(id);
      writes.delete(id);
      tombstones.set(id, {
        seq,
        at: now()
      });
      dirty.set(id, 'delete');
      tombstonesDirty = true;
      return seq;
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
          value: JSON.stringify(Object.fromEntries(tombstones))
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
      const legacyRaw = storage.get(legacyRowsKey());
      if (legacyRaw) {
        try {
          const migrated = [];
          for (const row of JSON.parse(legacyRaw)) {
            rows.set(row.id, row);
            migrated.push({
              key: rowKey(row.id),
              value: JSON.stringify(row)
            });
          }
          migrated.push({
            key: legacyRowsKey(),
            value: null
          });
          storage.set(migrated);
        } catch {
          storage.set([{
            key: legacyRowsKey(),
            value: null
          }]);
        }
      }
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