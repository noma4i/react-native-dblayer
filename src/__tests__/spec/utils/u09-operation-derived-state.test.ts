import { getOperationState, resetRuntime } from '../../testApi';
import { setupSpecRuntime } from '../helpers/harness';

const MODEL = 'SpecDerived';
const ROW = 'row-1';

const patchOperation = (operationId: string) => ({
  operationId,
  actionKey: `${MODEL}:action`,
  actionMode: 'request' as const,
  model: MODEL,
  tempIds: [],
  rowIds: [ROW],
  intent: 'patch' as const,
  patchedFields: ['title'],
  patchedValues: { title: 'local' },
  createdAt: 1
});

/**
 * Owner contract of the operation ledger's derived state. Every index here is a projection of
 * `operations`, so the only invariant that matters is that a projection cannot disagree with the
 * records it is derived from - whichever path last touched it. The cases below drive each mutating
 * path and then ask the projection the same question, because a projection maintained in one place
 * and repaired in another is exactly how a pending patch becomes invisible.
 */
describe('operation ledger derived state', () => {
  beforeEach(() => {
    setupSpecRuntime();
  });

  afterEach(() => {
    resetRuntime();
  });

  it('[OP9] still owns the patched field after a failed operation is reopened', () => {
    const ledger = getOperationState();
    ledger.begin(patchOperation('op-1'));
    ledger.close('op-1', 'failed');
    expect([...ledger.ownedFields(MODEL, ROW)]).toEqual([]);

    ledger.reopen('op-1');

    expect([...ledger.ownedFields(MODEL, ROW)]).toEqual(['title']);
    expect(ledger.latestPendingValue(MODEL, ROW, 'title')).toEqual({ found: true, value: 'local' });
  });

  it('[OP10] owns nothing once the only pending patch is removed', () => {
    const ledger = getOperationState();
    ledger.begin(patchOperation('op-1'));
    expect([...ledger.ownedFields(MODEL, ROW)]).toEqual(['title']);

    ledger.remove('op-1');

    expect([...ledger.ownedFields(MODEL, ROW)]).toEqual([]);
    expect(ledger.residentRowBuckets()).toBe(0);
  });

  it('keeps the surviving patch owning its field when another operation is removed', () => {
    const ledger = getOperationState();
    ledger.begin(patchOperation('op-1'));
    ledger.begin({ ...patchOperation('op-2'), patchedFields: ['body'], patchedValues: { body: 'other' } });

    ledger.remove('op-2');

    expect([...ledger.ownedFields(MODEL, ROW)]).toEqual(['title']);
  });

  it('owns nothing after a pending patch is cleared by a reset', () => {
    const ledger = getOperationState();
    ledger.begin(patchOperation('op-1'));

    ledger.reset();

    expect([...ledger.ownedFields(MODEL, ROW)]).toEqual([]);
    expect(ledger.residentRowBuckets()).toBe(0);
  });
});
