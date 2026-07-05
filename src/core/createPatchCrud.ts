import type { CreatePatchCrudConfig, PatchCrud } from '../types';
import { shouldAcceptIncoming } from './invariants';

/** Create patch and destroy helpers for a collection. */
export function createPatchCrud<T extends { id: string; updatedAt?: string | null }>(config: CreatePatchCrudConfig<T>): PatchCrud<T> {
  const patch = (id: string, updates: Partial<T>): boolean => {
    if (!config.collection.has(id)) return false;

    const existing = config.collection.get(id);
    if (!existing) return false;

    const updateRecord = updates as Record<string, unknown>;
    // Patch keeps partial update semantics: undefined incoming fields do not count as changes.
    if (!shouldAcceptIncoming(existing as T & Record<string, unknown>, updateRecord as Partial<T> & Record<string, unknown>, { timestampMode: 'when-both-present', equalityMode: 'defined-fields' })) return false;

    config.collection.update(id, draft => {
      const draftRecord = draft as Record<string, unknown>;
      for (const key of Object.keys(updateRecord)) {
        const value = updateRecord[key];
        if (value !== undefined) {
          draftRecord[key] = value;
        }
      }
    });

    return true;
  };

  const destroy = (id: string): boolean => {
    if (!config.collection.has(id)) return false;
    config.collection.delete(id);
    return true;
  };

  return { patch, destroy };
}
