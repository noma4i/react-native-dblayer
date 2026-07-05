"use strict";

/** Build a merge sync contract for server data writes. */
export const mergeSyncContract = (source, scope) => ({
  mode: 'merge',
  source,
  scope
});

/** Build a replace sync contract for server data writes. */
export const replaceSyncContract = (source, scope) => ({
  mode: 'replace',
  source,
  scope
});
//# sourceMappingURL=serverSync.js.map