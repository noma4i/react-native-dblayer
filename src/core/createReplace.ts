import type { CreateReplaceConfig, ReplaceResult } from '../types';
import { shouldAcceptIncoming } from './invariants';

/** Create a replace writer that upserts incoming rows and deletes rows missing from the incoming set. */
export function createReplace<TInput, TOutput extends { id: string }>(
  config: CreateReplaceConfig<TInput, TOutput>
): (items: TInput[], scopeFilter?: (item: TOutput) => boolean) => ReplaceResult {
  return (items: TInput[], scopeFilter?: (item: TOutput) => boolean): ReplaceResult => {
    const normalized = items.map(item => config.normalize(item)).filter((item): item is TOutput => item !== null);

    const newIds = new Set<string>();
    for (const item of normalized) {
      newIds.add(item.id);
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
    for (const id of config.collection.keys()) {
      const idStr = String(id);
      if (newIds.has(idStr)) continue;
      if (scopeFilter) {
        const existing = config.collection.get(idStr);
        if (existing && !scopeFilter(existing)) continue;
      }
      toDelete.push(idStr);
    }

    for (const id of toDelete) {
      config.collection.delete(id);
    }

    return { merged: normalized.length, deleted: toDelete.length };
  };
}
