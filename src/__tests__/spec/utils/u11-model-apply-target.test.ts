import { createModelApplyTarget, createModelContext } from '../../testApi';
import { setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; bucket: string; rank: number } & Record<string, unknown>;

const buildTarget = (modelId: string) => {
  const context = createModelContext<Row>({ modelId, scopeNames: ['byBucket'], relations: () => ({}), applyWriteGate: (_previous, incoming) => incoming });
  return createModelApplyTarget<Row>({
    modelId,
    scopes: { byBucket: { by: { bucket: 'bucket' } } },
    context,
    scopeSortedRows: () => [],
    prepareRow: row => ({ row: row as Row, changedFields: null }),
    preparePatch: (id, patch) => ({ row: { id, ...patch } as Row, changedFields: Object.keys(patch) }),
    putRows: rows => rows.map(row => ({ id: row.id, changedFields: null })),
    rowBelongsToScope: () => true
  });
};

/**
 * Owner contract of the model apply target. Building a target and publishing it to the process are
 * separate acts: the factory answers questions about one model's planes, and only the composition
 * root decides when that answer becomes the process-wide one. These cases call the factory directly,
 * which is possible exactly because it registers nothing - the same reason it can be built twice.
 */
describe('model apply target', () => {
  beforeEach(() => {
    setupSpecRuntime();
  });

  it('[A8] builds twice for one model id without claiming a process-wide slot', () => {
    const scopeKey = 'byBucket|{"bucket":"a"}';
    const first = buildTarget('SpecApplyTargetTwice');
    first.applyTarget.scopeDelta(scopeKey, { append: [{ id: 'row-1', orderKey: 'a' }], detach: [] });

    // Building a second target for the same model id registers nothing, so it starts empty and the
    // first one keeps serving what it holds.
    const second = buildTarget('SpecApplyTargetTwice');

    expect(second.applyTarget.readScopeEntries(scopeKey)).toEqual([]);
    expect(first.applyTarget.readScopeEntries(scopeKey)).toEqual([{ id: 'row-1', orderKey: 'a' }]);
    second.applyTarget.scopeDelta(scopeKey, { append: [{ id: 'row-2', orderKey: 'b' }], detach: [] });
    expect(first.applyTarget.readScopeEntries(scopeKey)).toEqual([{ id: 'row-1', orderKey: 'a' }]);
  });

  it('reports a scope order revision that moves when the scope order moves', () => {
    const { applyTarget } = buildTarget('SpecApplyTargetRevision');
    const scopeKey = 'byBucket|{"bucket":"a"}';
    const before = applyTarget.readScopeOrderRevision(scopeKey);

    applyTarget.scopeDelta(scopeKey, { append: [{ id: 'row-1', orderKey: 'a' }], detach: [] });

    expect(applyTarget.readScopeOrderRevision(scopeKey)).toBe(before + 1);
  });

  it('serves the scope entries it appended', () => {
    const { applyTarget } = buildTarget('SpecApplyTargetEntries');
    const scopeKey = 'byBucket|{"bucket":"a"}';

    applyTarget.scopeDelta(scopeKey, { append: [{ id: 'row-1', orderKey: 'a' }], detach: [] });

    expect(applyTarget.readScopeEntries(scopeKey)).toEqual([{ id: 'row-1', orderKey: 'a' }]);
  });

  it('forgets a row the scope detached', () => {
    const { applyTarget } = buildTarget('SpecApplyTargetDetach');
    const scopeKey = 'byBucket|{"bucket":"a"}';
    applyTarget.scopeDelta(scopeKey, { append: [{ id: 'row-1', orderKey: 'a' }], detach: [] });

    applyTarget.scopeDelta(scopeKey, { append: [], detach: ['row-1'] });

    expect(applyTarget.readScopeEntries(scopeKey)).toEqual([]);
  });
});
