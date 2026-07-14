export type EntityClock = { next(): number; current(): number };

export type Tombstone = { seq: number; at: number };

export type EntityState<T extends { id: string }> = {
  read(id: string): T | undefined;
  values(): T[];
  upsert(row: T): number;
  destroy(id: string): number;
  isTombstoned(id: string): boolean;
  snapshot(): number;
  wasWrittenAfter(id: string, capture: number): boolean;
  wasDestroyedAfter(id: string, capture: number): boolean;
  reset(): void;
};

export const createEntityState = <T extends { id: string }>(clock: EntityClock, now: () => number): EntityState<T> => {
  const rows = new Map<string, T>();
  const writes = new Map<string, number>();
  const tombstones = new Map<string, Tombstone>();

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
      tombstones.set(id, { seq, at: now() });
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

export const createEntityClock = (): EntityClock => {
  let sequence = 0;
  return { next: () => ++sequence, current: () => sequence };
};
