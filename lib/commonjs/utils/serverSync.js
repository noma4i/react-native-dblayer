"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.replaceSyncContract = exports.mergeSyncContract = void 0;
/** Build a merge sync contract for server data writes. */
const mergeSyncContract = (source, scope) => ({
  mode: 'merge',
  source,
  scope
});

/** Build a replace sync contract for server data writes. */
exports.mergeSyncContract = mergeSyncContract;
const replaceSyncContract = (source, scope) => ({
  mode: 'replace',
  source,
  scope
});
exports.replaceSyncContract = replaceSyncContract;
//# sourceMappingURL=serverSync.js.map