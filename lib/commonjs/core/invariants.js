"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isIncomingNewer = void 0;
/** Date.getTime() comparison - handles timezone offsets (Rails +11:00 vs client Z) */
const compareTimestamps = (a, b) => new Date(a).getTime() - new Date(b).getTime();

/** Return true when an incoming timestamp is newer or equal to the existing timestamp. */
const isIncomingNewer = (existingUpdatedAt, incomingUpdatedAt) => {
  if (!incomingUpdatedAt && !existingUpdatedAt) return true;
  if (!incomingUpdatedAt) return false;
  if (!existingUpdatedAt) return true;
  return compareTimestamps(incomingUpdatedAt, existingUpdatedAt) >= 0;
};
exports.isIncomingNewer = isIncomingNewer;
//# sourceMappingURL=invariants.js.map