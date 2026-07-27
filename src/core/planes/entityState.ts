import { stableSerialize } from '../serialize';
import { noteEntityUpsertGuardHit } from '../diagnostics';
import { CorruptionError } from '../recovery';
import type { WriteCtx } from '../../dsl/defineModel';
import type { StoragePlane } from './storagePlane';

type Tombstone = { at: number };

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

type UpsertResult = { changedFields: string[] | null };

export type EntityState<T extends { id: string }> = {
  read(id: string): T | undefined;
  values(): T[];
  /** Returns changed top-level fields vs the previous row, or null when the row is new. */
  upsert(row: T, options?: { mergeBase?: T; ctx?: WriteCtx }): UpsertResult;
  destroy(id: string, options?: { tombstone?: boolean }): void;
  /** Cache eviction (GC) - removes the row WITHOUT a tombstone; a later server row resurrects it. */
  evict(id: string): boolean;
  isTombstoned(id: string): boolean;
  pruneTombstones(): number;
  /** Serialize rows+tombstones into storage entries for the transaction's single persist batch. */
  persistEntries(): Array<{ key: string; value: string | null }>;
  ackPersist(): void;
  hydrate(): void;
  reset(): void;
};

const diffTopLevelFields = <T extends object>(previous: T, next: T): string[] => {
  const fields = new Set<string>();
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (!Object.is(previous[key], next[key])) fields.add(String(key));
  }
  for (const key of Object.keys(previous) as Array<keyof T>) {
    if (!(key in next)) fields.add(String(key));
  }
  return [...fields];
};

export const createEntityState = <T extends { id: string }>(options: {
  modelId: string;
  now: () => number;
  storage: StoragePlane;
  prefix: () => string;
  applyWriteGate?: (previous: T, incoming: T, ctx: WriteCtx) => T | null;
  ownedFields?: (rowId: string, excludeOperationId?: string) => ReadonlySet<string>;
}): EntityState<T> => {
  const { modelId, now, storage, prefix, applyWriteGate, ownedFields } = options;
  const rows = new Map<string, T>();
  const tombstones = new Map<string, Tombstone>();
  const dirty = new Map<string, 'set' | 'delete'>();
  let tombstonesDirty = false;
  const rowKey = (id: string) => `${prefix()}row:${modelId}:${id}`;
  const rowsPrefix = () => `${prefix()}row:${modelId}:`;
  const tombstonesKey = () => `${prefix()}tombstones:${modelId}`;
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
    }
    return pruned;
  };

  return {
    read: id => rows.get(String(id)),
    values: () => [...rows.values()],
    upsert: (row, options = {}) => {
      const id = String(row.id);
      if (row.id !== id) row = { ...row, id };
      const previous = rows.get(row.id);
      const mergePrevious = previous ?? options.mergeBase;
      if (previous === row) return { changedFields: [] };
      const ctx = options.ctx ?? { origin: 'snapshot' as const };
      if (mergePrevious && ctx.origin !== 'replace' && ctx.operationId === undefined && ownedFields) {
        const owned = ownedFields(row.id, ctx.operationId);
        if (owned.size > 0) {
          let overlaid: T | undefined;
          for (const field of owned) {
            if (!(field in mergePrevious)) continue;
            overlaid ??= { ...row };
            (overlaid as Record<string, unknown>)[field] = (mergePrevious as Record<string, unknown>)[field];
          }
          row = overlaid ?? row;
        }
      }
      if (mergePrevious && applyWriteGate) {
        const gated = applyWriteGate(mergePrevious, row, ctx);
        if (gated === null) return { changedFields: [] };
        row = gated;
      }
      const changedFields = previous ? diffTopLevelFields(previous, row) : null;
      if (changedFields !== null && changedFields.length === 0) return { changedFields };
      if (previous && changedFields !== null && changedFields.every(field => stableSerialize((previous as Record<string, unknown>)[field]) === stableSerialize((row as Record<string, unknown>)[field]))) {
        noteEntityUpsertGuardHit();
        return { changedFields: [] };
      }
      rows.set(row.id, row);
      dirty.set(row.id, 'set');
      if (tombstones.delete(row.id)) {
        tombstonesDirty = true;
      }
      return { changedFields };
    },
    destroy: (id, options = {}) => {
      id = String(id);
      rows.delete(id);
      if (options.tombstone !== false) tombstones.set(id, { at: now() }); // Preserve delete-before-create protection through the tombstone and defineModel's isTombstoned gate within the TTL.
      dirty.set(id, 'delete');
      if (options.tombstone !== false) tombstonesDirty = true;
    },
    evict: id => {
      id = String(id);
      if (!rows.delete(id)) return false;
      dirty.set(id, 'delete');
      return true;
    },
    isTombstoned: id => tombstones.has(String(id)),
    pruneTombstones: prune,
    persistEntries: () => {
      prune();
      const entries: Array<{ key: string; value: string | null }> = [];
      for (const [id, op] of dirty) {
        entries.push({ key: rowKey(id), value: op === 'set' ? JSON.stringify(rows.get(id)) : null });
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
      rows.clear();
      tombstones.clear();
      dirty.clear();
      tombstonesDirty = false;
      for (const fullKey of storage.keys(rowsPrefix())) {
        const raw = storage.get(fullKey);
        if (!raw) continue;
        try {
          const row = JSON.parse(raw) as T;
          if (typeof row.id !== 'string') row.id = String(row.id);
          rows.set(row.id, row);
        } catch {
          throw new CorruptionError('row', fullKey);
        }
      }
      const rawTombstones = storage.get(tombstonesKey());
      if (rawTombstones) {
        try {
          for (const [id, tombstone] of Object.entries(JSON.parse(rawTombstones) as Record<string, Tombstone>)) tombstones.set(id, tombstone);
        } catch {
          throw new CorruptionError('tombstones', tombstonesKey());
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
