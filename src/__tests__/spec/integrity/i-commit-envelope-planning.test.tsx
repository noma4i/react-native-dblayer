import { configureDb, defineModel, f } from '../../../index';
import { createCommitEnvelope } from '../../../core/apply/transaction';
import { getInternalModelHandle } from '../../../core/internalHandles';
import { getApplyRuntime, getOperationState } from '../../../dsl/configure';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Row = { id: string; chatId: string; body: string };

const document = { kind: 'Document', definitions: [] } as never;

const defineRows = (suffix: string) =>
  defineModel({
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
  rows.mutation<{ send: { row: Row } }, Row, Row, Row>('send', {
    document,
    result: 'send',
    optimistic: {
      model: rows,
      build: (input, { tempId }) => ({ ...input, id: tempId! }),
      selectServerNode: data => data.send.row,
      correlate: { fields }
    }
  });

const beginInsert = (model: string, operationId: string, tempId: string): void => {
  getOperationState().begin({
    operationId,
    model,
    tempIds: [tempId],
    rowIds: [tempId],
    intent: 'insert',
    idempotencyKey: operationId,
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
          { id: 'row-1', orderKey: 'V', edge: { label: 'first' } },
          { id: 'row-1', orderKey: 'W', edge: { label: 'last' } }
        ],
        detach: []
      }
    ]);

    expect(envelope.scopeOps).toEqual([
      {
        kind: 'scope-delta',
        model: rows.modelId,
        scopeKey: 'scope-1',
        append: [{ id: 'row-1', orderKey: 'W', edge: { label: 'last' } }],
        detach: []
      }
    ]);
  });
});
