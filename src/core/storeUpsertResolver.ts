import { stableSerialize } from './serialize';
import { noteEntityUpsertGuardHit } from './diagnostics';
import type { EntityPlaneOptions, PreparedUpsert, RowRecord, WriteCtx } from '../types';

export const diffTopLevelFields = (previous: RowRecord, next: RowRecord): string[] => {
  const fields = new Set<string>();
  for (const key of Object.keys(next)) {
    if (!Object.is(previous[key], next[key])) fields.add(key);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) fields.add(key);
  }
  return [...fields];
};

/** True when every changed field is only a reference change with identical serialized value (upsert guard). */
export const isSerializedNoop = (previous: RowRecord, row: RowRecord, changedFields: string[]): boolean =>
  changedFields.every(field => stableSerialize(previous[field]) === stableSerialize(row[field]));

/**
 * Pure single-write resolver: id coercion, pending-field overlay, write-gate application, and the
 * serialized-noop upsert guard - no plane state is read or mutated.
 */
export const createUpsertResolver = (
  options: Pick<EntityPlaneOptions, 'applyWriteGate' | 'ownedFields'>
): { previewUpsert: (incoming: RowRecord, upsertOptions: { previous: RowRecord | undefined; mergeBase?: RowRecord; ctx?: WriteCtx }) => PreparedUpsert<RowRecord> } => {
  const { applyWriteGate, ownedFields } = options;
  const previewUpsert = (
    incoming: RowRecord,
    upsertOptions: { previous: RowRecord | undefined; mergeBase?: RowRecord; ctx?: WriteCtx }
  ): PreparedUpsert<RowRecord> => {
    let row = incoming;
    const id = String(row.id);
    if (row.id !== id) row = { ...row, id };
    const previous = upsertOptions.previous;
    const mergePrevious = previous ?? upsertOptions.mergeBase;
    if (previous === row) return { row, changedFields: [] };
    const ctx = upsertOptions.ctx ?? { origin: 'snapshot' as const };
    if (mergePrevious && ctx.origin !== 'replace' && ctx.operationId === undefined && ownedFields) {
      const owned = ownedFields(row.id, ctx.operationId);
      if (owned.size > 0) {
        let overlaid: RowRecord | undefined;
        for (const field of owned) {
          if (!(field in mergePrevious)) continue;
          overlaid ??= { ...row };
          overlaid[field] = mergePrevious[field];
        }
        row = overlaid ?? row;
      }
    }
    if (mergePrevious) row = applyWriteGate(mergePrevious, row, ctx);
    const changedFields = previous ? diffTopLevelFields(previous, row) : null;
    if (previous && changedFields !== null && changedFields.length > 0 && isSerializedNoop(previous, row, changedFields)) {
      noteEntityUpsertGuardHit();
      return { row: previous, changedFields: [] };
    }
    return { row, changedFields };
  };
  return { previewUpsert };
};
