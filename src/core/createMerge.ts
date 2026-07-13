import type { CreateMergeConfig, DbCollection, MergeResult } from '../types';
import { shouldAcceptIncoming } from './invariants';

const fnv1a = (items: Array<{ id: string; updatedAt?: string | null }>): number => {
  let hash = 2166136261;
  const length = String(items.length);
  for (let i = 0; i < length.length; i++) {
    hash ^= length.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  for (let i = 0; i < items.length; i++) {
    const s = `${items[i]!.id}|${items[i]!.updatedAt ?? ''}|${i}`;
    for (let j = 0; j < s.length; j++) {
      hash ^= s.charCodeAt(j);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash;
};

const upsertIfNewer = <T extends { id: string; updatedAt?: string | null }>(
  collection: DbCollection<T>,
  item: Partial<T> & { id: string },
  shouldOverwrite?: (existing: T, incoming: Partial<T> & { id: string }) => boolean,
  snapshotSeq?: number,
  versionCore?: CreateMergeConfig<unknown, T>['versionCore'],
  resurrectionTtlMs?: number
): boolean => {
  const key = String(item.id);
  if (snapshotSeq !== undefined && versionCore?.wasDeletedAfter(key, snapshotSeq)) return false;
  if (snapshotSeq === undefined && resurrectionTtlMs !== undefined && versionCore?.wasDeletedWithin(key, resurrectionTtlMs)) return false;
  if (!collection.has(key)) {
    collection.insert(item as T);
    return true;
  }

  const existing = collection.get(key);
  if (!existing) {
    collection.insert(item as T);
    return true;
  }

  // Merge keeps the strict timestamp gate: an existing timestamp rejects a missing incoming timestamp.
  if (!shouldAcceptIncoming(existing as T & Record<string, unknown>, item as Partial<T> & { id: string } & Record<string, unknown>, { shouldOverwrite })) return false;

  collection.update(key, draft => {
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (v !== undefined) {
        (draft as Record<string, unknown>)[k] = v;
      }
    }
  });
  return true;
};

/** Create a merge writer that upserts incoming rows when they are accepted by the freshness gate. */
export function createMerge<TInput, TOutput extends { id: string; updatedAt?: string | null }>(config: CreateMergeConfig<TInput, TOutput>): (items: TInput[], snapshotSeq?: number) => MergeResult {
  let lastMergeTimestamp = 0;
  let lastMergeKey = 0;
  const reset = (): void => {
    lastMergeTimestamp = 0;
    lastMergeKey = 0;
  };

  config.registerReset?.(reset);

  return (items: TInput[], snapshotSeq?: number): MergeResult => {
    if (!items.length) return { merged: 0 };

    const normalized = items.map(item => config.normalize(item)).filter((item): item is Partial<TOutput> & { id: string } => item !== null);
    const dedupeWindowMs = config.dedupeWindowMs ?? config.resolveDedupeWindowMs?.() ?? 0;

    if (dedupeWindowMs > 0) {
      const now = Date.now();
      const key = fnv1a(normalized);
      if (now - lastMergeTimestamp < dedupeWindowMs && key === lastMergeKey) {
        return { merged: 0 };
      }
      lastMergeTimestamp = now;
      lastMergeKey = key;
    }

    let mergedCount = 0;

    for (const item of normalized) {
      if (upsertIfNewer(config.collection, item, config.shouldOverwrite, snapshotSeq, config.versionCore, config.resurrectionTtlMs)) {
        mergedCount++;
      }
    }

    return { merged: mergedCount };
  };
}
