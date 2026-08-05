import { bootDb, compositeStorageKey, configureDb, encodePersistence, resetRuntime, type QueryPersistenceRecord, type StoragePlane } from '../../testApi';
import { invalidatePersistedQuery, readPersistedQuery, readPersistedQueryFamily, removePersistedQuery, writePersistedQuery } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

const declaration = {
  family: 'query-persistence-contract',
  persistenceVersion: 1,
  fingerprint: 'fingerprint'
};

const record = (overrides: Partial<QueryPersistenceRecord<string, null>> = {}): QueryPersistenceRecord<string, null> => ({
  recordVersion: 2,
  family: declaration.family,
  identity: 'identity',
  persistenceVersion: declaration.persistenceVersion,
  fingerprint: declaration.fingerprint,
  scope: null,
  payload: 'value',
  empty: false,
  dataUpdatedAt: 1,
  invalidated: false,
  invalidationRevision: 0,
  ...overrides
});

const keyOf = (family = declaration.family, identity = 'identity'): string => compositeStorageKey('dbl:', 'query', family, identity);

describe('query persistence records', () => {
  it('[P15] hydrates zero query records on boot: restoration is reader-driven, never a namespace scan', async () => {
    const memory = createMemoryPlane();
    for (let index = 0; index < 40; index += 1) {
      memory.set(compositeStorageKey('dbl:', 'query', `family-${index}`, `identity-${index}`), encodePersistence(record()));
    }
    let queryReads = 0;
    let queryKeyScans = 0;
    const counting: StoragePlane = {
      get: key => {
        if (key.startsWith('dbl:query')) queryReads += 1;
        return memory.get(key);
      },
      set: memory.set,
      keys: prefix => {
        if (prefix.startsWith('dbl:query')) queryKeyScans += 1;
        return memory.keys(prefix);
      }
    };
    resetRuntime();
    configureDb({ storage: counting, transport: createMockTransport() });
    await bootDb();

    // 40 persisted query records on disk, and the boot read NONE of them: a reader restores
    // its own record on mount; boot-time work stays constant in the namespace size.
    expect(queryReads).toBe(0);
    expect(queryKeyScans).toBe(0);
  });

  it('[P14] removes corrupt, unsupported, and incompatible exact records', () => {
    const onSyncError = jest.fn();
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError }
    });

    storage.set(keyOf(), 'corrupt');
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(storage.get(keyOf())).toBeUndefined();

    storage.set(keyOf(), encodePersistence(record(), 99));
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(onSyncError).toHaveBeenCalledTimes(1);

    storage.set(keyOf(), encodePersistence(record({ persistenceVersion: 2 })));
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(storage.get(keyOf())).toBeUndefined();
  });

  it('removes corrupt and incompatible family records while retaining valid siblings', () => {
    const onSyncError = jest.fn();
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError }
    });
    [
      { key: keyOf(declaration.family, 'corrupt'), value: 'corrupt' },
      {
        key: keyOf(declaration.family, 'wrong-family'),
        value: encodePersistence(record({ identity: 'wrong-family', family: 'other-family' }))
      },
      {
        key: keyOf(declaration.family, 'valid'),
        value: encodePersistence(record({ identity: 'valid' }))
      }
    ].forEach(entry => storage.set(entry.key, entry.value));

    expect(readPersistedQueryFamily(declaration).map(value => value.identity)).toEqual(['valid']);
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(storage.snapshotKeys().filter(key => key.startsWith(compositeStorageKey('dbl:', 'query', declaration.family)))).toEqual([keyOf(declaration.family, 'valid')]);
  });

  it('removes a family record whose declared identity does not match its storage key', () => {
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: {}
    });
    const forgedKey = keyOf(declaration.family, 'physical-identity');
    storage.set(forgedKey, encodePersistence(record({ identity: 'declared-identity' })));

    expect(readPersistedQueryFamily(declaration)).toEqual([]);
    expect(storage.get(forgedKey)).toBeUndefined();
    expect(storage.get(keyOf(declaration.family, 'declared-identity'))).toBeUndefined();
  });

  it('[P24] drops stale-version exact and family records silently without a corruption report', () => {
    const onSyncError = jest.fn();
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError }
    });

    storage.set(keyOf(), encodePersistence({ ...(record() as Record<string, unknown>), recordVersion: 1 }));
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(onSyncError).not.toHaveBeenCalled();
    expect(storage.get(keyOf())).toBeUndefined();

    storage.set(keyOf(declaration.family, 'stale'), encodePersistence({ ...(record({ identity: 'stale' }) as Record<string, unknown>), recordVersion: 1 }));
    storage.set(keyOf(declaration.family, 'valid'), encodePersistence(record({ identity: 'valid' })));
    expect(readPersistedQueryFamily(declaration).map(value => value.identity)).toEqual(['valid']);
    expect(onSyncError).not.toHaveBeenCalled();
    expect(storage.get(keyOf(declaration.family, 'stale'))).toBeUndefined();
  });

  it('drops a stale-version invalidation record without a corruption report', () => {
    const onSyncError = jest.fn();
    const storage = createMemoryPlane();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError }
    });

    const invalidationKey = compositeStorageKey('dbl:', 'query-invalidation', declaration.family);
    storage.set(invalidationKey, encodePersistence({ recordVersion: 0, revision: 1, identities: {} }));
    storage.set(keyOf(), encodePersistence(record()));
    expect(
      readPersistedQuery(declaration, 'identity', value => ({
        payload: value.payload as string,
        scope: null
      }))
    ).toBeUndefined();
    expect(onSyncError).not.toHaveBeenCalled();
    expect(storage.get(invalidationKey)).toBeUndefined();
  });

  it('ignores a disappeared family key and rejects non-JSON scope and payload values', () => {
    const base = createMemoryPlane();
    const ghostKey = keyOf(declaration.family, 'ghost');
    const storage: StoragePlane = {
      get: key => (key === ghostKey ? undefined : base.get(key)),
      set: (key, value) => base.set(key, value),
      keys: prefix => [...base.keys(prefix), ...(ghostKey.startsWith(prefix) ? [ghostKey] : [])]
    };
    const onSyncError = jest.fn();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { onSyncError }
    });

    expect(readPersistedQueryFamily(declaration)).toEqual([]);
    expect(
      writePersistedQuery({
        ...declaration,
        identity: 'bad-scope',
        scope: Symbol('scope'),
        payload: 'value',
        empty: false,
        dataUpdatedAt: 1
      })
    ).toBe(false);
    expect(
      writePersistedQuery({
        ...declaration,
        identity: 'bad-payload',
        scope: null,
        payload: Symbol('payload'),
        empty: false,
        dataUpdatedAt: 1
      })
    ).toBe(false);
    expect(onSyncError).toHaveBeenCalledTimes(2);
  });

  it('[P46] counts fingerprint-class removals, reports identity-key mismatch as corruption, keeps stale-version silent', () => {
    const onSyncError = jest.fn();
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport(), defaults: { onSyncError } });
    diagnostics().reset();
    const fingerprintResets = () => diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'query-record-fingerprint-reset').length;
    const validate = (value: QueryPersistenceRecord) => ({ payload: value.payload as string, scope: null });

    // Exact read, fingerprint mismatch: counted removal, no corruption report.
    storage.set(keyOf(), encodePersistence(record({ fingerprint: 'moved' })));
    expect(readPersistedQuery(declaration, 'identity', validate)).toBeUndefined();
    expect(fingerprintResets()).toBe(1);
    expect(onSyncError).not.toHaveBeenCalled();

    // Exact read, identity-vs-key mismatch: corruption class, not a fingerprint reset.
    storage.set(keyOf(), encodePersistence(record({ identity: 'foreign' })));
    expect(readPersistedQuery(declaration, 'identity', validate)).toBeUndefined();
    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(fingerprintResets()).toBe(1);

    // Family read: family and persistenceVersion mismatches count per removal, stale-version stays silent.
    storage.set(keyOf(declaration.family, 'a'), encodePersistence(record({ identity: 'a', family: 'other-family' })));
    storage.set(keyOf(declaration.family, 'b'), encodePersistence(record({ identity: 'b', persistenceVersion: 9 })));
    storage.set(keyOf(declaration.family, 'c'), encodePersistence({ ...(record({ identity: 'c' }) as Record<string, unknown>), recordVersion: 1 }));
    expect(readPersistedQueryFamily(declaration)).toEqual([]);
    expect(fingerprintResets()).toBe(3);
    expect(onSyncError).toHaveBeenCalledTimes(1);

    // Family read, identity-vs-key mismatch: corruption class.
    storage.set(keyOf(declaration.family, 'physical'), encodePersistence(record({ identity: 'declared' })));
    expect(readPersistedQueryFamily(declaration)).toEqual([]);
    expect(onSyncError).toHaveBeenCalledTimes(2);
    expect(fingerprintResets()).toBe(3);

    // Exact read judges EVERY fingerprint-class field, not only the fingerprint itself.
    storage.set(keyOf(), encodePersistence(record({ family: 'other-family' })));
    expect(readPersistedQuery(declaration, 'identity', validate)).toBeUndefined();
    expect(fingerprintResets()).toBe(4);
    storage.set(keyOf(), encodePersistence(record({ persistenceVersion: 9 })));
    expect(readPersistedQuery(declaration, 'identity', validate)).toBeUndefined();
    expect(fingerprintResets()).toBe(5);
    // Family read judges the fingerprint field too.
    storage.set(keyOf(declaration.family, 'd'), encodePersistence(record({ identity: 'd', fingerprint: 'moved' })));
    expect(readPersistedQueryFamily(declaration)).toEqual([]);
    expect(fingerprintResets()).toBe(6);
    // The loss event carries its full identity: mechanism, runtime model, unit count.
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'query-record-fingerprint-reset', model: '__runtime__', count: 1 });
  });

  it('[P23] invalidates every accepted family record with one physical write', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport(), defaults: {} });
    writePersistedQuery({ ...record({ identity: 'first' }) });
    writePersistedQuery({ ...record({ identity: 'second' }) });
    const set = storage.set;
    let invalidationWrites = 0;
    storage.set = (key, value) => {
      invalidationWrites += 1;
      if (invalidationWrites === 2) throw new Error('process killed after first invalidation write');
      set(key, value);
    };

    try {
      expect(() => invalidatePersistedQuery(declaration, () => true)).not.toThrow();
    } finally {
      storage.set = set;
    }
    expect(invalidationWrites).toBe(1);
    expect(readPersistedQueryFamily(declaration).map(value => [value.identity, value.invalidated])).toEqual([
      ['first', true],
      ['second', true]
    ]);
  });

  it('keeps surviving records stale when family removal stops between keys', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport(), defaults: {} });
    writePersistedQuery({ ...record({ identity: 'first' }) });
    writePersistedQuery({ ...record({ identity: 'second' }) });
    const set = storage.set;
    let deletions = 0;
    storage.set = (key, value) => {
      if (value === null) {
        deletions += 1;
        if (deletions === 2) throw new Error('process killed during family removal');
      }
      set(key, value);
    };

    try {
      expect(() => removePersistedQuery(declaration)).toThrow('process killed during family removal');
    } finally {
      storage.set = set;
    }
    expect(readPersistedQueryFamily(declaration).map(value => value.invalidated)).toEqual([true]);
  });
});
