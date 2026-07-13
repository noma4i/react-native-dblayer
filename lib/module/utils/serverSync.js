"use strict";

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = (source, scope) => ({
  mode: 'merge',
  source,
  scope
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