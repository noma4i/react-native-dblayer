"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.replaceSyncContract = exports.mergeSyncContract = void 0;
/** Build a merge sync contract for server data writes. */
const mergeSyncContract = (source, scope, protectAfterSeq) => ({
  mode: 'merge',
  source,
  scope,
  ...(protectAfterSeq === undefined ? {} : {
    protectAfterSeq
  })
});

/** Build a replace sync contract for server data writes. */
exports.mergeSyncContract = mergeSyncContract;
const replaceSyncContract = (source, scope, protectAfterSeq) => ({
  mode: 'replace',
  source,
  scope,
  ...(protectAfterSeq === undefined ? {} : {
    protectAfterSeq
  })
});
exports.replaceSyncContract = replaceSyncContract;
//# sourceMappingURL=serverSync.js.map