"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isIncomingNewer = void 0;
/** Date.getTime() comparison - handles timezone offsets (Rails +11:00 vs client Z). NaN for an unparseable string. */
const parseTimestamp = value => new Date(value).getTime();

/**
 * Return true when an incoming `updatedAt` is newer than or equal to the existing one - the newer-wins
 * acceptance gate used to decide whether an incoming write should overwrite a stored row. Nullish AND
 * unparseable (NaN-parsing) timestamps are treated identically as "missing": both missing accepts,
 * only-existing-missing accepts, only-incoming-missing rejects (an incoming row with no provable
 * timestamp cannot prove it is newer, so an unparseable string is never silently treated as a match
 * via `NaN` comparisons - it is explicitly folded into the same missing-value branch as `null`/`undefined`).
 *
 * @param existingUpdatedAt The stored row's `updatedAt`, or nullish/unparseable if absent/never set.
 * @param incomingUpdatedAt The incoming row's `updatedAt`, or nullish/unparseable if absent.
 * @returns `true` when the incoming write should be accepted.
 */
const isIncomingNewer = (existingUpdatedAt, incomingUpdatedAt) => {
  const existingMs = existingUpdatedAt ? parseTimestamp(existingUpdatedAt) : Number.NaN;
  const incomingMs = incomingUpdatedAt ? parseTimestamp(incomingUpdatedAt) : Number.NaN;
  const existingMissing = Number.isNaN(existingMs);
  const incomingMissing = Number.isNaN(incomingMs);
  if (incomingMissing && existingMissing) return true;
  if (incomingMissing) return false;
  if (existingMissing) return true;
  return incomingMs - existingMs >= 0;
};
exports.isIncomingNewer = isIncomingNewer;
//# sourceMappingURL=invariants.js.map