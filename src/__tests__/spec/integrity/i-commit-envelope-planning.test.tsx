import { configureDb, defineModelRuntime, f , createCommitEnvelope , getInternalModelHandle , compositeKey , getApplyRuntime, getOperationState, registerMutationCorrelator } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; chatId: string; body: string };

const defineRows = (suffix: string) =>
  defineModelRuntime({
    id: `CommitEnvelopePlanning${suffix}`,
    name: `CommitEnvelopePlanning${suffix}`,
    fields: {
      id: f.str(),
      chatId: f.str(),
      body: f.str()
    },
    maintenance: { dropTempRowsAfterMs: 60_000 }
  });

const defineCorrelation = (rows: ReturnType<typeof defineRows>, fields: Array<keyof Row>) =>
  registerMutationCorrelator(rows.modelId, `${rows.modelId}:send`, { fields });

const beginInsert = (model: string, operationId: string, tempId: string): void => {
  getOperationState().begin({
    operationId,
    actionKey: `${model}:send`,
    actionMode: 'request',
    model,
    tempIds: [tempId],
    rowIds: [tempId],
    intent: 'insert',
    createdAt: 1
  });
};

describe('commit-envelope planning purity', () => {
  it('keeps a correlated pending operation open until the planned rows commit', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('Pending');
    defineCorrelation(rows, ['chatId', 'body']);
    const tempId = 'temp-pending';
    beginInsert(rows.modelId, 'op-pending', tempId);
    rows.insert({ id: tempId, chatId: 'chat-1', body: 'hello' });

    const plan = getInternalModelHandle(rows).planRows([{ id: 'server-1', chatId: 'chat-1', body: 'hello' }]);

    expect(getOperationState().get('op-pending')?.status).toBe('pending');
    getApplyRuntime().commit(createCommitEnvelope(plan));
    expect(getOperationState().get('op-pending')?.status).toBe('committed');
  });

  it('keeps a failed operation in memory until the replacement plan commits', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('Failed');
    const tempId = 'temp-failed';
    beginInsert(rows.modelId, 'op-failed', tempId);
    getOperationState().close('op-failed', 'failed');
    rows.insert({ id: tempId, chatId: 'chat-1', body: 'hello' });

    const plan = getInternalModelHandle(rows).planReplace(tempId, { id: 'server-1', chatId: 'chat-1', body: 'hello' });

    expect(getOperationState().failedFor(rows.modelId, tempId)?.operationId).toBe('op-failed');
    getApplyRuntime().commit(createCommitEnvelope(plan));
    expect(getOperationState().failedFor(rows.modelId, tempId)).toBeUndefined();
  });

  it('rejects an invalid replacement before planning any write', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('InvalidReplacement');

    expect(() => getInternalModelHandle(rows).planReplace('temp-invalid', null)).toThrow(`replace rejected for ${rows.modelId}:temp-invalid`);
  });

  it('replaces a correlator declaration with the same model and mutation identity', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('Registry');
    defineCorrelation(rows, ['chatId']);
    defineCorrelation(rows, ['chatId', 'body']);
    const tempId = 'temp-registry';
    beginInsert(rows.modelId, 'op-registry', tempId);
    rows.insert({ id: tempId, chatId: 'chat-1', body: 'first' });

    const plan = getInternalModelHandle(rows).planRows([{ id: 'server-1', chatId: 'chat-1', body: 'different' }]);

    expect(plan.some(op => op.kind === 'destroy' && op.ids.includes(tempId))).toBe(false);
  });

  it('deduplicates scope-delta members before the commit envelope reaches WAL', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('ScopeDeltaDedup');

    const envelope = createCommitEnvelope([
      {
        kind: 'scope-delta',
        model: rows.modelId,
        scopeKey: 'scope-1',
        append: [
          { id: 'row-1', orderKey: 'V' },
          { id: 'row-1', orderKey: 'W' }
        ],
        detach: []
      }
    ]);

    expect(envelope.scopeOps).toEqual([
      {
        kind: 'scope-delta',
        model: rows.modelId,
        scopeKey: 'scope-1',
        append: [{ id: 'row-1', orderKey: 'W' }],
        detach: []
      }
    ]);
  });

  it('assigns unique order keys to sorted-scope appends whose rows are not yet resolvable', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'CommitEnvelopePlanningPlacement',
      name: 'CommitEnvelopePlanningPlacement',
      fields: { rank: f.num() },
      scopes: { list: ({ sort: { field: 'rank', dir: 'asc' } }) }
    });

    const envelope = createCommitEnvelope([
      {
        kind: 'scope-delta',
        model: rows.modelId,
        scopeKey: compositeKey('list', '{}'),
        append: [{ id: 'ghost-a' }, { id: 'ghost-b' }, { id: 'ghost-c' }],
        detach: []
      }
    ]);

    const delta = envelope.scopeOps.find(op => op.kind === 'scope-delta');
    const orderKeys = delta && delta.kind === 'scope-delta' ? delta.append.map(entry => entry.orderKey) : [];
    expect(orderKeys).toHaveLength(3);
    expect(new Set(orderKeys).size).toBe(3);
  });
});
