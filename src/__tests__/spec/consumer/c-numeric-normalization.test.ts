import {
  compositeStorageKey,
  configureDb,
  defineModelRuntime,
  encodePersistence,
  f,
  isNonArrayRecord,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord
} from '../../testApi';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

describe('numeric field normalization', () => {
  it('drops non-finite numbers and canonicalizes negative zero', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecNumericNormalization',
      name: 'SpecNumericNormalization',
      fields: { value: f.num(), nullableValue: f.num().nullable() }
    });

    expect(rows.normalize({ id: 'nan', value: Number.NaN, nullableValue: Number.NaN })).toEqual({ id: 'nan' });
    expect(rows.normalize({ id: 'infinity', value: Number.POSITIVE_INFINITY, nullableValue: Number.NEGATIVE_INFINITY })).toEqual({ id: 'infinity' });
    expect(rows.normalize({ id: 'zero', value: -0, nullableValue: -0 })).toEqual({ id: 'zero', value: 0, nullableValue: 0 });
    expect(rows.normalize({ id: 'null', value: 1, nullableValue: null })).toEqual({ id: 'null', value: 1, nullableValue: null });
  });

  it('converts numeric transport strings to stored numbers', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecNumericTransportNormalization',
      name: 'SpecNumericTransportNormalization',
      fields: { value: f.num() }
    });

    expect(rows.normalize({ id: 'decimal', value: '2.5' })).toEqual({ id: 'decimal', value: 2.5 });
    expect(rows.normalize({ id: 'blank', value: '   ' })).toEqual({ id: 'blank' });
  });

  it('converts integer transport values and rejects fractional or unsafe values', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecIntegerTransportNormalization',
      name: 'SpecIntegerTransportNormalization',
      fields: { value: f.int() }
    });

    expect(rows.normalize({ id: 'string', value: '42' })).toEqual({ id: 'string', value: 42 });
    expect(rows.normalize({ id: 'number', value: 42 })).toEqual({ id: 'number', value: 42 });
    expect(rows.normalize({ id: 'fraction', value: '2.5' })).toEqual({ id: 'fraction' });
    expect(rows.normalize({ id: 'unsafe', value: String(Number.MAX_SAFE_INTEGER + 1) })).toEqual({ id: 'unsafe' });
  });
});

describe('normalization helpers', () => {
  it('stores every supported timestamp input as one ISO value on the row and drops unusable input', () => {
    setupSpecRuntime();
    const iso = '2026-01-02T03:04:05.000Z';
    const rows = defineModelRuntime({
      id: 'SpecTimestampFieldNormalization',
      name: 'SpecTimestampFieldNormalization',
      fields: { at: f.date() }
    });

    rows.insert({ id: 'date-instance', at: new Date(iso) as never });
    rows.insert({ id: 'epoch-number', at: new Date(iso).getTime() as never });
    rows.insert({ id: 'iso-string', at: iso });
    rows.insert({ id: 'garbage', at: 'not-a-timestamp' });
    rows.insert({ id: 'missing' } as never);

    expect(rows.find('date-instance')).toEqual({ id: 'date-instance', at: iso });
    expect(rows.find('epoch-number')).toEqual({ id: 'epoch-number', at: iso });
    expect(rows.find('iso-string')).toEqual({ id: 'iso-string', at: iso });
    expect(rows.find('garbage')).toEqual({ id: 'garbage' });
    expect(rows.find('missing')).toEqual({ id: 'missing' });
  });

  it('compares newerBy timestamps as instants through the model write path and rejects unprovable incoming stamps', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecNewerByTimestamps',
      name: 'SpecNewerByTimestamps',
      fields: { value: f.str(), updatedAt: f.date().nullable() },
      write: { groups: [{ fields: ['value', 'updatedAt'] as const, policy: { monotonic: { newerBy: 'updatedAt' } } }] }
    });
    rows.insert({ id: 'row-1', value: 'first', updatedAt: '2026-01-02T03:04:05.000Z' });

    rows.insertMany([{ id: 'row-1', value: 'older', updatedAt: '2026-01-02T03:04:04.000Z' }]);
    expect(rows.find('row-1')).toEqual({ id: 'row-1', value: 'first', updatedAt: '2026-01-02T03:04:05.000Z' });

    // The same instant written with a timezone offset compares equal as an instant, not as a string.
    rows.insertMany([{ id: 'row-1', value: 'offset', updatedAt: '2026-01-02T14:04:05.000+11:00' }]);
    expect(rows.find('row-1')).toEqual({ id: 'row-1', value: 'offset', updatedAt: '2026-01-02T14:04:05.000+11:00' });

    rows.insertMany([{ id: 'row-1', value: 'unproven', updatedAt: null }]);
    expect(rows.find('row-1')).toEqual({ id: 'row-1', value: 'offset', updatedAt: '2026-01-02T14:04:05.000+11:00' });

    rows.insertMany([{ id: 'row-1', value: 'newer', updatedAt: '2026-01-02T03:04:06.000Z' }]);
    expect(rows.find('row-1')).toEqual({ id: 'row-1', value: 'newer', updatedAt: '2026-01-02T03:04:06.000Z' });
  });

  it('drops persisted rows and tombstone records that fail boundary classification on model hydrate', async () => {
    type GateRow = { id: string; value: string; bucket: string };
    type GateScope = { bucket: string };
    const storage = createMemoryPlane();
    const responsesByBucket: Record<string, GateRow[]> = {
      gated: [{ id: 'gated', value: 'blocked', bucket: 'gated' }],
      invalid: [{ id: 'negative-at', value: 'landed', bucket: 'invalid' }]
    };
    const transport = createMockTransport({
      query: async <TData,>(operation: { variables?: unknown }) => ({
        data: { rows: responsesByBucket[(operation.variables as GateScope).bucket] } as TData
      })
    });
    configureDb({ storage, transport });
    const modelId = 'SpecClassifierHydrate';
    const invalidTombstoneModelId = 'SpecClassifierHydrateInvalidTombstones';
    const rowKey = (id: string): string => compositeStorageKey('dbl:', 'row', modelId, id);
    const document = { kind: 'Document', definitions: [] } as never;
    const defineGateModel = (id: string) =>
      defineModelRuntime({
        id,
        name: id,
        fields: { value: f.str(), bucket: f.str() },
        scopes: { byBucket: { by: { bucket: 'bucket' } } }
      });

    storage.set(rowKey('keep'), encodePersistence({ id: 'keep', value: 'kept', bucket: 'seed' }));
    storage.set(rowKey('empty-id'), encodePersistence({ id: '', value: 'dropped' }));
    storage.set(rowKey('array-row'), encodePersistence(['not', 'a', 'row']));
    storage.set(rowKey('null-row'), encodePersistence(null));
    // Tombstone `at` boundaries: 0 is a valid stamp, -1 and MAX_SAFE_INTEGER + 1 poison the whole record.
    storage.set(compositeStorageKey('dbl:', 'tombstones', modelId), encodePersistence({ gated: { at: 0 } }));
    storage.set(
      compositeStorageKey('dbl:', 'tombstones', invalidTombstoneModelId),
      encodePersistence({ 'negative-at': { at: -1 }, 'unsafe-at': { at: Number.MAX_SAFE_INTEGER + 1 } })
    );

    const rows = defineGateModel(modelId);
    expect(rows.all()).toEqual([{ id: 'keep', value: 'kept', bucket: 'seed' }]);
    // Rejected row payloads are deleted from the plane, the valid one stays.
    expect(storage.snapshotKeys().filter(key => key.startsWith(`dbl:row:${modelId.length}:${modelId}`))).toEqual([rowKey('keep')]);

    // The surviving valid tombstone gates a snapshot landing of the same id.
    const gatedQuery = rows.query<{ rows: GateRow[] }, GateScope, GateScope, GateRow>('classifier-gate', {
      document,
      vars: value => value,
      select: data => data.rows,
      into: rows.scopes.byBucket
    });
    await gatedQuery.fetch({ bucket: 'gated' });
    expect(rows.find('gated')).toBeUndefined();

    // The rejected tombstone record protects nothing: the same landing lands on the sibling model.
    const sibling = defineGateModel(invalidTombstoneModelId);
    const openQuery = sibling.query<{ rows: GateRow[] }, GateScope, GateScope, GateRow>('classifier-open', {
      document,
      vars: value => value,
      select: data => data.rows,
      into: sibling.scopes.byBucket
    });
    await openQuery.fetch({ bucket: 'invalid' });
    expect(sibling.find('negative-at')).toEqual({ id: 'negative-at', value: 'landed', bucket: 'invalid' });
    // The rejected tombstone record is also cleared from the plane while the valid record survives.
    expect(storage.get(compositeStorageKey('dbl:', 'tombstones', invalidTombstoneModelId))).toBeUndefined();
    expect(storage.get(compositeStorageKey('dbl:', 'tombstones', modelId))).toBe(encodePersistence({ gated: { at: 0 } }));
  });

  it('classifies plain records against arrays and positive safe integers at their boundaries', () => {
    // No public path reaches these branches directly: isRecord's array-permissive branch is only
    // consulted behind isNonArrayRecord call sites covered above, and isPositiveSafeInteger has no
    // production consumer, so the literal boundary values are asserted on the helpers themselves.
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isNonArrayRecord({})).toBe(true);
    expect(isNonArrayRecord([])).toBe(false);
    expect(isNonEmptyString('x')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonNegativeSafeInteger(0)).toBe(true);
    expect(isNonNegativeSafeInteger(-1)).toBe(false);
    expect(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});
