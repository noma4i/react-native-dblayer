"use strict";

/** Date.getTime() comparison — handles timezone offsets (Rails +11:00 vs client Z) */
const compareTimestamps = (a, b) => new Date(a).getTime() - new Date(b).getTime();

/** Return true when an incoming timestamp is newer or equal to the existing timestamp. */
export const isIncomingNewer = (existingUpdatedAt, incomingUpdatedAt) => {
  if (!incomingUpdatedAt && !existingUpdatedAt) return true;
  if (!incomingUpdatedAt) return false;
  if (!existingUpdatedAt) return true;
  return compareTimestamps(incomingUpdatedAt, existingUpdatedAt) >= 0;
};

/** Compare two plain records by shallow key/value equality. */
export const shallowEqual = (a, b) => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};
const hasDefinedFieldChange = (existing, incoming) => {
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && existing[key] !== value) return true;
  }
  return false;
};

/** Return true when an incoming row should overwrite an existing row. */
export const shouldAcceptIncoming = (existing, incoming, options = {}) => {
  const existingRecord = existing;
  const incomingRecord = incoming;
  const equalityMode = options.equalityMode ?? 'full';
  const hasChanges = equalityMode === 'defined-fields' ? hasDefinedFieldChange(existingRecord, incomingRecord) : !shallowEqual(existingRecord, incomingRecord);
  if (!hasChanges) return false;
  const timestampMode = options.timestampMode ?? 'incoming-newer';
  const shouldCheckTimestamp = timestampMode === 'incoming-newer' || Boolean(existing.updatedAt) && Boolean(incoming.updatedAt);
  if (shouldCheckTimestamp && !isIncomingNewer(existing.updatedAt, incoming.updatedAt) && options.shouldOverwrite?.(existing, incoming) !== true) {
    return false;
  }
  return true;
};
//# sourceMappingURL=invariants.js.map