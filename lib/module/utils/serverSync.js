"use strict";

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = (source, scope, snapshotSeq) => ({
  mode: 'merge',
  source,
  scope,
  ...(snapshotSeq === undefined ? {} : {
    snapshotSeq
  })
});

/** Build a replace sync contract for server data writes. */
export const replaceSyncContract = (source, scope, snapshotSeq) => ({
  mode: 'replace',
  source,
  scope,
  ...(snapshotSeq === undefined ? {} : {
    snapshotSeq
  })
});
//# sourceMappingURL=serverSync.js.map