import type { CreateReplaceConfig, ReplaceResult } from '../types';
import { shouldAcceptIncoming } from './invariants';
import { getDbLogger } from './logger';

/** Create a replace writer that upserts incoming rows and deletes rows missing from the incoming set. */
export function createReplace<TInput, TOutput extends { id: string }>(
  config: CreateReplaceConfig<TInput, TOutput>
): (items: TInput[], scopeFilter?: (item: TOutput) => boolean, snapshotSeq?: number) => ReplaceResult {
  return (items: TInput[], scopeFilter?: (item: TOutput) => boolean, snapshotSeq?: number): ReplaceResult => {
    const normalized = items.map(item => config.normalize(item)).filter((item): item is TOutput => item !== null);

    const newIds = new Set<string>();
    let resurrectionProtectedCount = 0;
    for (const item of normalized) {
      newIds.add(item.id);
      if (snapshotSeq !== undefined && config.versionCore.wasDeletedAfter(item.id, snapshotSeq)) {
        resurrectionProtectedCount++;
        continue;
      }
      if (config.collection.has(item.id)) {
        const existing = config.collection.get(item.id);
        if (existing) {
          // Replace keeps the timestamp gate only when both sides carry updatedAt.
          if (
            !shouldAcceptIncoming(existing as TOutput & Record<string, unknown>, item as TOutput & Record<string, unknown>, {
              timestampMode: 'when-both-present',
              shouldOverwrite: config.shouldOverwrite
            })
          ) {
            continue;
          }
        }
        config.collection.update(item.id, draft => {
          for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
            if (value !== undefined) {
              (draft as Record<string, unknown>)[key] = value;
            }
          }
        });
      } else {
        config.collection.insert(item);
      }
    }

    const toDelete: string[] = [];
    let protectedCount = 0;
    for (const id of config.collection.keys()) {
      const idStr = String(id);
      if (newIds.has(idStr)) continue;
      if (scopeFilter) {
        const existing = config.collection.get(idStr);
        if (existing && !scopeFilter(existing)) continue;
      }
      if (snapshotSeq !== undefined && config.versionCore.wasWrittenAfter(idStr, snapshotSeq)) {
        protectedCount++;
        continue;
      }
      toDelete.push(idStr);
    }

    if (protectedCount > 0 || resurrectionProtectedCount > 0) {
      getDbLogger().debug('db', 'replace:protected', { protectedCount, resurrectionProtectedCount, snapshotSeq });
    }

    for (const id of toDelete) {
      config.collection.delete(id);
    }

    return { merged: normalized.length, deleted: toDelete.length };
  };
}
