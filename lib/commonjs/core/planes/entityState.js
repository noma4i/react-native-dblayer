"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createEntityState = exports.createEntityClock = void 0;
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
const createEntityState = options => {
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
  const rowsKey = () => `${prefix()}rows:${modelId}`;
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
      tombstones.delete(row.id);
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
      return seq;
    },
    isTombstoned: id => tombstones.has(id),
    snapshot: () => clock.current(),
    wasWrittenAfter: (id, capture) => (writes.get(id) ?? 0) > capture,
    wasDestroyedAfter: (id, capture) => (tombstones.get(id)?.seq ?? 0) > capture,
    pruneTombstones: prune,
    persistEntries: () => {
      prune();
      return [{
        key: rowsKey(),
        value: JSON.stringify([...rows.values()])
      }, {
        key: tombstonesKey(),
        value: JSON.stringify(Object.fromEntries(tombstones))
      }];
    },
    hydrate: () => {
      rows.clear();
      writes.clear();
      tombstones.clear();
      const rawRows = storage.get(rowsKey());
      if (rawRows) {
        try {
          for (const row of JSON.parse(rawRows)) rows.set(row.id, row);
        } catch {
          storage.set([{
            key: rowsKey(),
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
    }
  };
};
exports.createEntityState = createEntityState;
const createEntityClock = () => {
  let sequence = 0;
  return {
    next: () => ++sequence,
    current: () => sequence,
    restore: value => {
      sequence = Math.max(sequence, value);
    }
  };
};
exports.createEntityClock = createEntityClock;
//# sourceMappingURL=entityState.js.map