"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.takeQuarantineEntries = exports.readQuarantineEntries = exports.putQuarantine = void 0;
var _configure = require("../dsl/configure.js");
var _logger = require("./logger.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _diagnostics = require("./diagnostics.js");
var _syncError = require("./syncError.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
/**
 * THE quarantine: the single writer of the `quarantine` durable namespace. A payload that fails
 * validation is kept here verbatim with its reason - never dropped. User-class entries (`ledger`,
 * `operation`) are never removed automatically; cache-class entries (`row`) are a bounded FIFO.
 * Removal happens only through an explicit take (fsck restore) or the user's own runtime reset.
 */

const CACHE_ENTRY_CAP = 100;
const quarantineKey = prefix => `${prefix}quarantine`;
const isQuarantineEntry = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && (value.kind === 'ledger' || value.kind === 'operation' || value.kind === 'row') && typeof value.model === 'string' && (0, _normalizeHelpers.isNonEmptyString)(value.id) && (0, _normalizeHelpers.isNonEmptyString)(value.reason) && Object.hasOwn(value, 'raw');
const isQuarantineState = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && Array.isArray(value.entries) && value.entries.every(isQuarantineEntry);
const readState = () => {
  const raw = (0, _configure.getDbRuntimeConfig)().storage.get(quarantineKey((0, _configure.getStoragePrefix)()));
  if (raw === undefined) return {
    entries: []
  };
  const decoded = (0, _persistenceCodec.decodePersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, isQuarantineState);
  if (decoded.kind === 'ok') return decoded.value;
  // The quarantine itself is the end of the recovery chain: an unreadable quarantine is logged
  // loudly and restarted empty rather than quarantined recursively.
  (0, _logger.getDbLogger)().error('quarantine state unreadable, restarting empty', {
    kind: decoded.kind
  });
  return {
    entries: []
  };
};
const writeState = state => {
  (0, _configure.getDbRuntimeConfig)().storage.set(quarantineKey((0, _configure.getStoragePrefix)()), (0, _persistenceCodec.encodePersistence)(state));
};

/** Keep one rejected payload with its reason instead of dropping it. */
const putQuarantine = entry => {
  const raw = (0, _persistenceCodec.jsonRoundTrip)(entry.raw);
  const state = readState();
  // The writer normalizes its own keys: a nameless payload must not make the stored state unreadable.
  const id = (0, _normalizeHelpers.isNonEmptyString)(entry.id) ? entry.id : '(unnamed)';
  state.entries.push({
    ...entry,
    id,
    raw: raw.serializable ? raw.value : String(entry.raw)
  });
  const cacheEntries = state.entries.filter(candidate => candidate.kind === 'row');
  if (cacheEntries.length > CACHE_ENTRY_CAP) {
    const oldestCache = cacheEntries[0];
    state.entries.splice(state.entries.indexOf(oldestCache), 1);
  }
  writeState(state);
  (0, _diagnostics.noteQuarantinePut)();
  (0, _syncError.reportSyncError)(new Error(`quarantined ${entry.kind} ${entry.model}/${entry.id}: ${entry.reason}`), {
    source: 'quarantine',
    model: entry.model,
    key: entry.id
  }, 'quarantine');
};

/** Every quarantined payload, oldest first. */
exports.putQuarantine = putQuarantine;
const readQuarantineEntries = () => readState().entries.map(entry => ({
  ...entry
}));

/** Remove and return the entries the predicate accepts - the only automatic removal path (fsck restore). */
exports.readQuarantineEntries = readQuarantineEntries;
const takeQuarantineEntries = accepts => {
  const state = readState();
  const taken = state.entries.filter(accepts);
  if (taken.length === 0) return [];
  writeState({
    entries: state.entries.filter(entry => !accepts(entry))
  });
  return taken;
};
exports.takeQuarantineEntries = takeQuarantineEntries;
//# sourceMappingURL=quarantine.js.map