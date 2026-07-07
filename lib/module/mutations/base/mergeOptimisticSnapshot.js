"use strict";

export const resolveMergedField = (optimisticValue, serverValue) => {
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