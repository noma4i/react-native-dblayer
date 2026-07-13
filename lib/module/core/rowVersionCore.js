"use strict";

/** Create the collection-local version ledger used to arbitrate server and local writes. */
export const createRowVersionCore = options => {
  let sequence = 0;
  const marks = new Map();
  const maxDeleteMarks = options?.maxDeleteMarks ?? 10_000;
  const pruneDeleteMarks = () => {
    let deleteMarks = 0;
    for (const mark of marks.values()) {
      if (mark.d !== undefined) deleteMarks++;
    }
    while (deleteMarks > maxDeleteMarks) {
      let oldestDeleteId;
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
      marks.set(id, {
        w: sequence
      });
    },
    noteDelete: id => {
      sequence += 1;
      marks.set(id, {
        d: sequence
      });
      pruneDeleteMarks();
    },
    snapshot: () => sequence,
    wasWrittenAfter: (id, snapshotSeq) => (marks.get(id)?.w ?? 0) > snapshotSeq,
    wasDeletedAfter: (id, snapshotSeq) => (marks.get(id)?.d ?? 0) > snapshotSeq,
    getWriteSeq: id => marks.get(id)?.w,
    getDeleteSeq: id => marks.get(id)?.d,
    reset: () => {
      marks.clear();
    }
  };
};
//# sourceMappingURL=rowVersionCore.js.map