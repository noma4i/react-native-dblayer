import type {
  QueryPersistenceDeclaration,
  QueryPersistenceRecord,
  QueryPersistenceWrite
} from '../types';
import { getDbRuntimeConfig, getStoragePrefix } from '../dsl/configure';
import { isRecord } from '../utils/normalizeHelpers';
import {
  decodePersistence,
  encodePersistence,
  jsonRoundTrip,
  PERSISTENCE_SCHEMA_VERSION
} from './persistenceCodec';
import { compositeStorageKey } from './serialize';
import { reportSyncError } from './syncError';

const QUERY_RECORD_VERSION = 1;

const isQueryPersistenceRecord = (value: unknown): value is QueryPersistenceRecord =>
  isRecord(value) &&
  value.recordVersion === QUERY_RECORD_VERSION &&
  typeof value.family === 'string' &&
  typeof value.identity === 'string' &&
  Number.isSafeInteger(value.persistenceVersion) &&
  typeof value.fingerprint === 'string' &&
  typeof value.empty === 'boolean' &&
  typeof value.dataUpdatedAt === 'number' &&
  Number.isFinite(value.dataUpdatedAt) &&
  value.dataUpdatedAt >= 0 &&
  typeof value.invalidated === 'boolean' &&
  Object.hasOwn(value, 'scope') &&
  Object.hasOwn(value, 'payload');

const familyPrefix = (family: string): string =>
  compositeStorageKey(getStoragePrefix(), 'query', family);

const recordKey = (family: string, identity: string): string =>
  compositeStorageKey(getStoragePrefix(), 'query', family, identity);

const removeKeys = (keys: readonly string[]): void => {
  if (keys.length === 0) return;
  getDbRuntimeConfig().storage.set(keys.map(key => ({ key, value: null })));
};

const reportRejectedRecord = (family: string, error: unknown): void => {
  reportSyncError(error, { source: 'query', key: family }, 'queryPersistence');
};

export const readPersistedQuery = <TPayload, TScope>(
  declaration: QueryPersistenceDeclaration,
  identity: string,
  validate: (record: QueryPersistenceRecord) => { payload: TPayload; scope: TScope }
): QueryPersistenceRecord<TPayload, TScope> | undefined => {
  const storage = getDbRuntimeConfig().storage;
  const key = recordKey(declaration.family, identity);
  const raw = storage.get(key);
  if (raw === undefined) return undefined;
  const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, isQueryPersistenceRecord);
  if (decoded.kind !== 'ok') {
    removeKeys([key]);
    if (decoded.kind === 'corrupt') {
      reportRejectedRecord(declaration.family, new Error('react-native-dblayer: corrupt persisted query record'));
    }
    return undefined;
  }
  const record = decoded.value;
  if (
    record.family !== declaration.family ||
    record.identity !== identity ||
    record.persistenceVersion !== declaration.persistenceVersion ||
    record.fingerprint !== declaration.fingerprint
  ) {
    removeKeys([key]);
    return undefined;
  }
  try {
    const validated = validate(record);
    return { ...record, payload: validated.payload, scope: validated.scope };
  } catch (error) {
    removeKeys([key]);
    reportRejectedRecord(declaration.family, error);
    return undefined;
  }
};

export const readPersistedQueryFamily = (
  declaration: QueryPersistenceDeclaration
): QueryPersistenceRecord[] => {
  const storage = getDbRuntimeConfig().storage;
  const records: QueryPersistenceRecord[] = [];
  for (const key of storage.keys(familyPrefix(declaration.family))) {
    const raw = storage.get(key);
    if (raw === undefined) continue;
    const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, isQueryPersistenceRecord);
    if (
      decoded.kind !== 'ok' ||
      decoded.value.family !== declaration.family ||
      decoded.value.persistenceVersion !== declaration.persistenceVersion ||
      decoded.value.fingerprint !== declaration.fingerprint
    ) {
      removeKeys([key]);
      if (decoded.kind === 'corrupt') {
        reportRejectedRecord(declaration.family, new Error('react-native-dblayer: corrupt persisted query record'));
      }
      continue;
    }
    records.push(decoded.value);
  }
  return records;
};

export const writePersistedQuery = <TPayload, TScope>(
  input: QueryPersistenceWrite<TPayload, TScope>
): boolean => {
  const scope = jsonRoundTrip(input.scope);
  const payload = jsonRoundTrip(input.payload);
  if (!scope.serializable || !payload.serializable) {
    reportRejectedRecord(
      input.family,
      new Error('react-native-dblayer: persisted query scope and payload must be lossless JSON values')
    );
    return false;
  }
  const record: QueryPersistenceRecord<TPayload, TScope> = {
    recordVersion: QUERY_RECORD_VERSION,
    family: input.family,
    identity: input.identity,
    persistenceVersion: input.persistenceVersion,
    fingerprint: input.fingerprint,
    scope: scope.value,
    payload: payload.value,
    empty: input.empty,
    dataUpdatedAt: input.dataUpdatedAt,
    invalidated: input.invalidated ?? false
  };
  getDbRuntimeConfig().storage.set([
    {
      key: recordKey(input.family, input.identity),
      value: encodePersistence(record)
    }
  ]);
  return true;
};

export const invalidatePersistedQuery = (
  declaration: QueryPersistenceDeclaration,
  accepts: (record: QueryPersistenceRecord) => boolean
): QueryPersistenceRecord[] => {
  const records = readPersistedQueryFamily(declaration).filter(accepts);
  for (const record of records) {
    writePersistedQuery({ ...record, invalidated: true });
  }
  return records;
};

export const removePersistedQuery = (
  declaration: QueryPersistenceDeclaration,
  identity?: string
): void => {
  if (identity !== undefined) {
    removeKeys([recordKey(declaration.family, identity)]);
    return;
  }
  removeKeys(getDbRuntimeConfig().storage.keys(familyPrefix(declaration.family)));
};
