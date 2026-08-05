import { configureDb, defineModelRuntime, f, getApplyRuntime, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Row = { id: string; accountId: string; label: string };
type ScopeValue = { accountId: string };
type QueryResult = { rows: Row[] };

const document = { kind: 'Document', definitions: [] } as never;

describe('account switch integrity', () => {
  it('D4 hydrates touched model planes from the storage configured after reset', () => {
    const storageA = createMemoryPlane();
    const preparedStorage = createMemoryPlane();
    const storageB = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage: preparedStorage, transport });
    const rows = defineModelRuntime({ id: 'AccountSwitchPlanes', name: 'AccountSwitchPlanes', fields: { accountId: f.str(), label: f.str() } });

    rows.insert({ id: 'row-1', accountId: 'B', label: 'persisted account' });
    getApplyRuntime().flushCacheSnapshots();
    preparedStorage.snapshotKeys().map(key => ({ key, value: preparedStorage.get(key) ?? null })).forEach(entry => storageB.set(entry.key, entry.value));

    resetRuntime();
    configureDb({ storage: storageA, transport });
    expect(rows.find('row-1')).toBeUndefined();

    resetRuntime();
    configureDb({ storage: storageB, transport });

    expect(rows.find('row-1')).toMatchObject({ accountId: 'B', label: 'persisted account' });
  });

  it('rebinds model planes to the newly configured storage on configureDb re-entry without resetRuntime', () => {
    const storageA = createMemoryPlane();
    const preparedStorage = createMemoryPlane();
    const storageB = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage: preparedStorage, transport });
    const rows = defineModelRuntime({ id: 'ConfigureReentryPlanes', name: 'ConfigureReentryPlanes', fields: { accountId: f.str(), label: f.str() } });

    rows.insert({ id: 'row-1', accountId: 'B', label: 'persisted account' });
    getApplyRuntime().flushCacheSnapshots();
    preparedStorage.snapshotKeys().map(key => ({ key, value: preparedStorage.get(key) ?? null })).forEach(entry => storageB.set(entry.key, entry.value));

    configureDb({ storage: storageA, transport });
    expect(rows.find('row-1')).toBeUndefined();

    configureDb({ storage: storageB, transport });
    expect(rows.find('row-1')).toMatchObject({ accountId: 'B', label: 'persisted account' });
  });

  it('keeps committed rows across configureDb re-entry without any flush step', () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage, transport });
    const rows = defineModelRuntime({ id: 'ReentryImmediatePersist', name: 'ReentryImmediatePersist', fields: { label: f.str() } });
    rows.insert({ id: 'row-1', label: 'unflushed' });

    configureDb({ storage, transport });

    // Persistence is immediate: the new runtime hydrates the row straight from the commit's write.
    expect(rows.find('row-1')).toMatchObject({ label: 'unflushed' });
  });

  it('D9 rejects undefined by-scope values before query transport and permits null as disabled', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { rows: [] } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModelRuntime({
      id: 'AccountSwitchScope',
      name: 'AccountSwitchScope',
      fields: { accountId: f.str(), label: f.str() },
      scopes: { byAccount: ({ by: { accountId: 'accountId' } }) }
    });
    const query = rows.query<QueryResult, ScopeValue, ScopeValue, Row>('byAccount', {
      document,
      vars: value => value,
      select: data => data.rows,
      into: rows.scopes.byAccount
    });

    expect(() => renderCounted(() => rows.scopes.byAccount.use(undefined as never))).toThrow('scope value must provide accountId');
    expect(() => rows.scopes.byAccount.read(null as never)).not.toThrow();
    await expect(query.fetch({} as ScopeValue)).rejects.toThrow('scope value must provide accountId');
    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(0);
  });
});
