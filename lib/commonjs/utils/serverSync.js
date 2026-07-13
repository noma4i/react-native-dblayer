"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.replaceSyncContract = exports.mergeSyncContract = void 0;
/** Build a merge sync contract for server data writes. */
const mergeSyncContract = (source, scope, snapshotSeq) => ({
  mode: 'merge',
  source,
  scope,
  ...(snapshotSeq === undefined ? {} : {
    snapshotSeq
  })
});

/** Build a replace sync contract for server data writes. */
exports.mergeSyncContract = mergeSyncContract;
const replaceSyncContract = (source, scope, snapshotSeq) => ({
  mode: 'replace',
  source,
  scope,
  ...(snapshotSeq === undefined ? {} : {
    snapshotSeq
  })
});
exports.replaceSyncContract = replaceSyncContract;
//# sourceMappingURL=serverSync.js.map