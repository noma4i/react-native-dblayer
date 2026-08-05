import { getDbRuntimeConfig, getStoragePrefix } from '../dsl/configure';
import { getDbLogger } from './logger';
import { decodePersistence, encodePersistence, jsonRoundTrip, PERSISTENCE_SCHEMA_VERSION } from './persistenceCodec';
import { noteQuarantinePut } from './diagnostics';
import { reportSyncError } from './syncError';
import { isNonArrayRecord, isNonEmptyString } from '../utils/normalizeHelpers';
import type { QuarantineEntry, QuarantineState } from '../types/core.quarantine.types';

/**
 * THE quarantine: the single writer of the `quarantine` durable namespace. A payload that fails
 * validation is kept here verbatim with its reason - never dropped. User-class entries (`ledger`,
 * `operation`) are never removed automatically; cache-class entries (`row`) are a bounded FIFO.
 * Removal happens only through an explicit take (fsck restore) or the user's own runtime reset.
 */

const CACHE_ENTRY_CAP = 100;

const quarantineKey = (prefix: string): string => `${prefix}quarantine`;

const isQuarantineEntry = (value: unknown): value is QuarantineEntry =>
  isNonArrayRecord(value) &&
  (value.kind === 'ledger' || value.kind === 'operation' || value.kind === 'row') &&
  typeof value.model === 'string' &&
  isNonEmptyString(value.id) &&
  isNonEmptyString(value.reason) &&
  Object.hasOwn(value, 'raw');

const isQuarantineState = (value: unknown): value is QuarantineState =>
  isNonArrayRecord(value) && Array.isArray(value.entries) && value.entries.every(isQuarantineEntry);

const readState = (): QuarantineState => {
  const raw = getDbRuntimeConfig().storage.get(quarantineKey(getStoragePrefix()));
  if (raw === undefined) return { entries: [] };
  const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, isQuarantineState);
  if (decoded.kind === 'ok') return decoded.value;
  // The quarantine itself is the end of the recovery chain: an unreadable quarantine is logged
  // loudly and restarted empty rather than quarantined recursively.
  getDbLogger().error('quarantine state unreadable, restarting empty', { kind: decoded.kind });
  return { entries: [] };
};

const writeState = (state: QuarantineState): void => {
  getDbRuntimeConfig().storage.set(quarantineKey(getStoragePrefix()), encodePersistence(state));
};

/** Keep one rejected payload with its reason instead of dropping it. */
export const putQuarantine = (entry: QuarantineEntry): void => {
  const raw = jsonRoundTrip(entry.raw);
  const state = readState();
  // The writer normalizes its own keys: a nameless payload must not make the stored state unreadable.
  const id = isNonEmptyString(entry.id) ? entry.id : '(unnamed)';
  state.entries.push({ ...entry, id, raw: raw.serializable ? raw.value : String(entry.raw) });
  const cacheEntries = state.entries.filter(candidate => candidate.kind === 'row');
  if (cacheEntries.length > CACHE_ENTRY_CAP) {
    const oldestCache = cacheEntries[0]!;
    state.entries.splice(state.entries.indexOf(oldestCache), 1);
  }
  writeState(state);
  noteQuarantinePut();
  reportSyncError(new Error(`quarantined ${entry.kind} ${entry.model}/${entry.id}: ${entry.reason}`), { source: 'quarantine', model: entry.model, key: entry.id }, 'quarantine');
};

/** Every quarantined payload, oldest first. */
export const readQuarantineEntries = (): QuarantineEntry[] => readState().entries.map(entry => ({ ...entry }));

/** Remove and return the entries the predicate accepts - the only automatic removal path (fsck restore). */
export const takeQuarantineEntries = (accepts: (entry: QuarantineEntry) => boolean): QuarantineEntry[] => {
  const state = readState();
  const taken = state.entries.filter(accepts);
  if (taken.length === 0) return [];
  writeState({ entries: state.entries.filter(entry => !accepts(entry)) });
  return taken;
};
