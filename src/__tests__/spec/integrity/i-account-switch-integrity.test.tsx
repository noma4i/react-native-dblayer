import { configureDb, defineModelRuntime, f, resetRuntime , flushPersistence, replayJournal } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Row = { id: string; accountId: string; label: string };
type ScopeValue = { accountId: string };
type QueryResult = { rows: Row[] };
type SendResult = { send: { row: Row } };

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
    flushPersistence();
    storageB.set(preparedStorage.snapshotKeys().map(key => ({ key, value: preparedStorage.get(key) ?? null })));

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
    flushPersistence();
    storageB.set(preparedStorage.snapshotKeys().map(key => ({ key, value: preparedStorage.get(key) ?? null })));

    configureDb({ storage: storageA, transport });
    expect(rows.find('row-1')).toBeUndefined();

    configureDb({ storage: storageB, transport });
    expect(rows.find('row-1')).toMatchObject({ accountId: 'B', label: 'persisted account' });
  });

  it('recovers unflushed committed rows from the WAL after configureDb re-entry', () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport();
    configureDb({ storage, transport });
    const rows = defineModelRuntime({ id: 'ReentryWalRecovery', name: 'ReentryWalRecovery', fields: { label: f.str() } });
    rows.insert({ id: 'row-1', label: 'unflushed' });

    configureDb({ storage, transport });

    expect(storage.keys('dbl:journal:').length).toBeGreaterThan(0);
    expect(rows.find('row-1')).toBeUndefined();
    replayJournal();
    expect(rows.find('row-1')).toMatchObject({ label: 'unflushed' });
  });

  it('D8 rolls back optimistic state and pending dedupe when onMutate throws', async () => {
    let onMutateCalls = 0;
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { send: { row: { id: 'server-1', accountId: 'A', label: 'sent' } } } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = defineModelRuntime({ id: 'AccountSwitchMutation', name: 'AccountSwitchMutation', fields: { accountId: f.str(), label: f.str() }, maintenance: { dropTempRowsAfterMs: 1000 } });
    let firstTempId = '';
    const send = rows.mutation<SendResult, { label: string }, Row, Row>('send', {
      document,
      result: 'send',
      optimistic: {
        model: rows,
        failure: 'rollback',
        build: (input, context) => {
          if (!firstTempId) firstTempId = context.tempId!;
          return { id: context.tempId!, accountId: 'A', label: input.label };
        },
        selectServerNode: data => data.send.row
      },
      onMutate: () => {
        onMutateCalls += 1;
        if (onMutateCalls === 1) throw new Error('onMutate failed');
      }
    });

    await expect(send.run({ label: 'first' })).rejects.toThrow('onMutate failed');
    expect(rows.find(firstTempId)).toBeUndefined();
    const pending = renderCounted(() => rows.use.pending(firstTempId));
    expect(pending.result()).toBe(false);
    pending.unmount();

    await expect(send.run({ label: 'second' })).resolves.toMatchObject({ row: { id: 'server-1' } });
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
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
