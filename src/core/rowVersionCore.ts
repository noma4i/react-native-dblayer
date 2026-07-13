import type { RowVersionCore } from '../types';

type RowVersionMark = { w?: number; d?: number; deletedAt?: number };

/** Create the collection-local version ledger used to arbitrate server and local writes. */
export const createRowVersionCore = (options?: { maxDeleteMarks?: number }): RowVersionCore => {
  let sequence = 0;
  const marks = new Map<string, RowVersionMark>();
  const maxDeleteMarks = options?.maxDeleteMarks ?? 10_000;

  const pruneDeleteMarks = (): void => {
    let deleteMarks = 0;
    for (const mark of marks.values()) {
      if (mark.d !== undefined) deleteMarks++;
    }
    while (deleteMarks > maxDeleteMarks) {
      let oldestDeleteId: string | undefined;
      for (const [id, mark] of marks) {
        if (mark.d !== undefined) {
          oldestDeleteId = id;
          break;
        }
      }
      if (oldestDeleteId === undefined) return;
      marks.delete(oldestDeleteId);
      deleteMarks--;
    }
  };

  return {
    currentSeq: () => sequence,
    noteWrite: id => {
      sequence += 1;
      marks.set(id, { w: sequence });
    },
    noteDelete: id => {
      sequence += 1;
      marks.set(id, { d: sequence, deletedAt: Date.now() });
      pruneDeleteMarks();
    },
    snapshot: () => sequence,
    wasWrittenAfter: (id, snapshotSeq) => (marks.get(id)?.w ?? 0) > snapshotSeq,
    wasDeletedAfter: (id, snapshotSeq) => (marks.get(id)?.d ?? 0) > snapshotSeq,
    wasDeletedWithin: (id, ttlMs) => {
      const deletedAt = marks.get(id)?.deletedAt;
      return deletedAt !== undefined && ttlMs > 0 && Date.now() - deletedAt < ttlMs;
    },
    getWriteSeq: id => marks.get(id)?.w,
    getDeleteSeq: id => marks.get(id)?.d,
    reset: () => {
      marks.clear();
    }
  };
};
