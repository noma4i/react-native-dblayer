import {
  configureDb,
  correlateIncomingRow,
  getOperationState,
  modelHasCorrelators,
  registerMutationCorrelator
} from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const beginInsert = (options: {
  model: string;
  operationId: string;
  actionKey?: string;
  tempIds?: string[];
  createdAt?: number;
}): void => {
  getOperationState().begin({
    operationId: options.operationId,
    actionKey: options.actionKey ?? `${options.model}:unregistered`,
    actionMode: 'request',
    model: options.model,
    tempIds: options.tempIds ?? [],
    rowIds: options.tempIds ?? [],
    intent: 'insert',
    createdAt: options.createdAt ?? 1
  });
};

describe('mutation correlation', () => {
  it('rejects rows and operations that cannot identify one pending temp row', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = new Map<string, Record<string, unknown>>();
    const options = { readRow: (id: string) => rows.get(id), claimedTempIds: new Set<string>() };

    expect(modelHasCorrelators('SpecCorrelationNone')).toBe(false);
    expect(correlateIncomingRow('SpecCorrelationNone', { id: 'server-1' }, options)).toBeNull();

    const model = 'SpecCorrelationRejected';
    const actionKey = `${model}:send`;
    registerMutationCorrelator(model, actionKey, { fields: ['body'] });
    expect(modelHasCorrelators(model)).toBe(true);
    expect(correlateIncomingRow(model, { id: 'temp-incoming', body: 'hello' }, options)).toBeNull();
    rows.set('server-present', { id: 'server-present', body: 'hello' });
    expect(correlateIncomingRow(model, { id: 'server-present', body: 'hello' }, options)).toBeNull();

    beginInsert({ model, operationId: 'op-no-action', tempIds: ['temp-no-action'] });
    beginInsert({ model, operationId: 'op-wrong-action', actionKey: `${model}:other`, tempIds: ['temp-wrong-action'] });
    beginInsert({ model, operationId: 'op-no-temp', actionKey });
    beginInsert({ model, operationId: 'op-claimed', actionKey, tempIds: ['temp-claimed'] });
    beginInsert({ model, operationId: 'op-missing-row', actionKey, tempIds: ['temp-missing-row'] });
    beginInsert({ model, operationId: 'op-mismatch', actionKey, tempIds: ['temp-mismatch'] });
    rows.set('temp-claimed', { id: 'temp-claimed', body: 'hello' });
    rows.set('temp-mismatch', { id: 'temp-mismatch', body: 'different' });

    expect(
      correlateIncomingRow(model, { id: 'server-new', body: 'hello' }, {
        readRow: options.readRow,
        claimedTempIds: new Set(['temp-claimed'])
      })
    ).toBeNull();
  });

  it('applies custom matching and timestamp windows before choosing FIFO', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = new Map<string, Record<string, unknown>>();
    const readRow = (id: string) => rows.get(id);

    const customModel = 'SpecCorrelationCustom';
    const customAction = `${customModel}:send`;
    registerMutationCorrelator(customModel, customAction, {
      fields: ['body'],
      match: candidate => candidate.accept === true,
      createdAtWindowMs: 50
    });
    beginInsert({ model: customModel, operationId: 'op-custom-reject', actionKey: customAction, tempIds: ['temp-custom-reject'] });
    rows.set('temp-custom-reject', { id: 'temp-custom-reject', body: 'hello', accept: false, createdAt: 100 });
    expect(
      correlateIncomingRow(customModel, { id: 'server-custom-reject', body: 'hello', createdAt: 100 }, { readRow, claimedTempIds: new Set() })
    ).toBeNull();

    rows.set('temp-custom-reject', { id: 'temp-custom-reject', body: 'hello', accept: true });
    expect(
      correlateIncomingRow(customModel, { id: 'server-invalid-time', body: 'hello', createdAt: 100 }, { readRow, claimedTempIds: new Set() })
    ).toBeNull();

    rows.set('temp-custom-reject', { id: 'temp-custom-reject', body: 'hello', accept: true, createdAt: '1970-01-01T00:00:00.000Z' });
    expect(
      correlateIncomingRow(customModel, { id: 'server-wide-time', body: 'hello', createdAt: 100 }, { readRow, claimedTempIds: new Set() })
    ).toBeNull();

    const fifoModel = 'SpecCorrelationFifo';
    const fifoAction = `${fifoModel}:send`;
    registerMutationCorrelator(fifoModel, fifoAction, { fields: ['body'], createdAtWindowMs: 100 });
    beginInsert({ model: fifoModel, operationId: 'op-z', actionKey: fifoAction, tempIds: ['temp-z'], createdAt: 5 });
    beginInsert({ model: fifoModel, operationId: 'op-y', actionKey: fifoAction, tempIds: ['temp-y'], createdAt: 4 });
    beginInsert({ model: fifoModel, operationId: 'op-a', actionKey: fifoAction, tempIds: ['temp-a'], createdAt: 4 });
    getOperationState().close('op-z', 'failed');
    rows.set('temp-z', { id: 'temp-z', body: 'hello', createdAt: new Date(100) });
    rows.set('temp-y', { id: 'temp-y', body: 'hello', createdAt: 100 });
    rows.set('temp-a', { id: 'temp-a', body: 'hello', createdAt: '1970-01-01T00:00:00.100Z' });

    expect(
      correlateIncomingRow(fifoModel, { id: 'server-fifo', body: 'hello', createdAt: 100 }, { readRow, claimedTempIds: new Set() })
    ).toMatchObject({ tempId: 'temp-a', operation: { operationId: 'op-a' } });
  });
});
