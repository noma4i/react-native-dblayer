"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createEntityState = exports.createEntityClock = void 0;
const createEntityState = (clock, now) => {
  const rows = new Map();
  const writes = new Map();
  const tombstones = new Map();
  return {
    read: id => rows.get(id),
    values: () => [...rows.values()],
    upsert: row => {
      const seq = clock.next();
      rows.set(row.id, row);
      writes.set(row.id, seq);
      tombstones.delete(row.id);
      return seq;
    },
    destroy: id => {
      const seq = clock.next();
      rows.delete(id);
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
    current: () => sequence
  };
};
exports.createEntityClock = createEntityClock;
//# sourceMappingURL=entityState.js.map