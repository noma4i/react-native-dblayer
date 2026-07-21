"use strict";

/**
 * Choose a committed field value while preserving useful optimistic placeholders.
 *
 * @param optimisticValue Existing optimistic field value.
 * @param serverValue Incoming server field value.
 * @returns The optimistic value when the server value is nullish or empty string, otherwise the server value.
 */
const resolveMergedField = (optimisticValue, serverValue) => {
  if (serverValue === null || serverValue === undefined) {
    return optimisticValue;
  }
  if (typeof serverValue === 'string' && serverValue.length === 0) {
    return optimisticValue;
  }
  return serverValue;
};
const mergeAllFields = (optimistic, server, fieldMergers) => {
  if (!optimistic) {
    return server;
  }
  if (!server) {
    return optimistic;
  }
  const optimisticRecord = optimistic;
  const serverRecord = server;
  const merged = {
    ...optimisticRecord
  };
  const mergedKeys = new Set([...Object.keys(optimisticRecord), ...Object.keys(serverRecord)]);
  for (const key of mergedKeys) {
    const fieldMerger = fieldMergers?.[key];
    merged[key] = fieldMerger ? fieldMerger(optimisticRecord[key], serverRecord[key]) : resolveMergedField(optimisticRecord[key], serverRecord[key]);
  }
  return merged;
};

/**
 * Merge an optimistic row snapshot with a committed server node.
 *
 * @param optimistic Optimistic row captured before commit.
 * @param server Server node returned by the mutation.
 * @param options Optional field allowlist and custom field mergers.
 * @returns The merged object, or whichever side exists when the other side is nullish.
 */
export const mergeOptimisticSnapshot = (optimistic, server, options) => {
  if (!options?.fields) {
    return mergeAllFields(optimistic, server, options?.mergers);
  }
  if (!optimistic) {
    return server;
  }
  if (!server) {
    return optimistic;
  }
  const optimisticRecord = optimistic;
  const serverRecord = server;
  const merged = {
    ...serverRecord
  };
  for (const key of options.fields) {
    const fieldKey = key;
    const keyString = String(key);
    const fieldMerger = options.mergers?.[fieldKey];
    merged[keyString] = fieldMerger ? fieldMerger(optimisticRecord[keyString], serverRecord[keyString]) : resolveMergedField(optimisticRecord[keyString], serverRecord[keyString]);
  }
  return merged;
};
//# sourceMappingURL=mergeOptimisticSnapshot.js.map