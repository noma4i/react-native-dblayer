"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.serializeSingleFlightValue = exports.runSingleFlight = exports.createSingleFlightSignature = void 0;
const inFlightMutationRegistry = new Map();
const normalizeForStableSerialization = value => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeForStableSerialization(item));
  }
  if (typeof value === 'object') {
    const normalizedEntries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)).map(([entryKey, entryValue]) => [entryKey, normalizeForStableSerialization(entryValue)]);
    return Object.fromEntries(normalizedEntries);
  }
  return String(value);
};
const serializeSingleFlightValue = value => {
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(normalizeForStableSerialization(value));
};
exports.serializeSingleFlightValue = serializeSingleFlightValue;
const createSingleFlightSignature = (scope, mutationKey, payload) => {
  return `${scope}:${serializeSingleFlightValue(mutationKey)}:${serializeSingleFlightValue(payload)}`;
};
exports.createSingleFlightSignature = createSingleFlightSignature;
const runSingleFlight = (signature, execute) => {
  const existingPromise = inFlightMutationRegistry.get(signature);
  if (existingPromise) {
    return existingPromise;
  }
  const nextPromise = Promise.resolve().then(execute);
  const trackedPromise = nextPromise.finally(() => {
    if (inFlightMutationRegistry.get(signature) === trackedPromise) {
      inFlightMutationRegistry.delete(signature);
    }
  });
  inFlightMutationRegistry.set(signature, trackedPromise);
  return trackedPromise;
};
exports.runSingleFlight = runSingleFlight;
//# sourceMappingURL=singleFlight.js.map