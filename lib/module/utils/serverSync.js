"use strict";

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = (source, scope, protectAfterSeq) => ({
  mode: 'merge',
  source,
  scope,
  ...(protectAfterSeq === undefined ? {} : {
    protectAfterSeq
  })
});

/** Build a replace sync contract for server data writes. */
export const replaceSyncContract = (source, scope, protectAfterSeq) => ({
  mode: 'replace',
  source,
  scope,
  ...(protectAfterSeq === undefined ? {} : {
    protectAfterSeq
  })
});
//# sourceMappingURL=serverSync.js.map