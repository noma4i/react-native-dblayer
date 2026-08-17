import { getInternalScopeHandle, configureDb, defineModel, defineModelRuntime, defineShape, f , createCommitEnvelope , getInternalModelHandle , compositeKey , getApplyRuntime, getOperationState, hasMany, registerMutationCorrelator } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

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

  it('[W40] counts a snapshot landing gated by a live tombstone at the model prepare seam', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('TombstonePrepare');
    rows.insert({ id: 'row-1', chatId: 'chat-1', body: 'before' });
    rows.destroy('row-1');
    diagnostics().reset();

    getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planRows([{ id: 'row-1', chatId: 'chat-1', body: 'after' }])));

    expect(rows.find('row-1')).toBeUndefined();
    expect(diagnostics().snapshot().tombstoneWriteDrops).toBe(1);
  });

  it('[W40] counts a replace whose successor id is gated by a live tombstone', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('TombstoneSuccessor');
    rows.insert({ id: 'temp-1', chatId: 'chat-1', body: 'optimistic' });
    rows.insert({ id: 'server-1', chatId: 'chat-1', body: 'landed' });
    rows.destroy('server-1');
    diagnostics().reset();

    getApplyRuntime().commit(
      createCommitEnvelope(getInternalModelHandle(rows).planReplace('temp-1', { id: 'server-1', chatId: 'chat-1', body: 'response' }))
    );

    expect(rows.find('temp-1')).toBeUndefined();
    expect(rows.find('server-1')).toBeUndefined();
    expect(diagnostics().snapshot().tombstoneWriteDrops).toBe(1);
  });

  it('rejects an invalid replacement and leaves the store exactly as it was', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('InvalidReplacement');
    rows.insert({ id: 'temp-invalid', chatId: 'chat-1', body: 'draft' });

    expect(() => getInternalModelHandle(rows).planReplace('temp-invalid', null)).toThrow(`replace rejected for ${rows.modelId}:temp-invalid`);

    // Refused before planning: the row it names is untouched and no server row appeared.
    expect(rows.where({}).map(row => [row.id, row.body])).toEqual([['temp-invalid', 'draft']]);
  });

  it('replaces a correlator declaration with the same model and mutation identity', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('Registry');
    defineCorrelation(rows, ['chatId']);
    defineCorrelation(rows, ['chatId', 'body']);
    const tempId = 'temp-registry';
    beginInsert(rows.modelId, 'op-registry', tempId);
    rows.insert({ id: tempId, chatId: 'chat-1', body: 'first' });

    getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planRows([{ id: 'server-1', chatId: 'chat-1', body: 'different' }])));

    // The newest declaration owns correlation: a body mismatch means no correlation, so the pending
    // temp row stays next to the landed server row instead of being collapsed into it.
    expect(rows.where({}).map(row => [row.id, row.body])).toEqual([
      ['server-1', 'different'],
      ['temp-registry', 'first']
    ]);
  });

  it('seats one membership when a scope delta names the same row twice, at the LAST key it carries', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'CommitEnvelopeScopeDeltaDedup',
      name: 'CommitEnvelopeScopeDeltaDedup',
      fields: { chatId: f.str(), body: f.str() },
      scopes: { thread: ({ by: { chatId: 'chatId' }, sort: 'server-order' }) }
    });
    rows.insertMany([
      { id: 'row-1', chatId: 'chat-1', body: 'first' },
      { id: 'row-2', chatId: 'chat-1', body: 'second' }
    ]);
    const scopeKey = compositeKey('thread', '{"chatId":"chat-1"}');
    getApplyRuntime().commit(
      createCommitEnvelope([{ kind: 'scope-delta', model: rows.modelId, scopeKey, append: [{ id: 'row-2', orderKey: 'M' }], detach: [] }])
    );

    getApplyRuntime().commit(
      createCommitEnvelope([
        {
          kind: 'scope-delta',
          model: rows.modelId,
          scopeKey,
          append: [
            { id: 'row-1', orderKey: 'V' },
            { id: 'row-1', orderKey: 'B' }
          ],
          detach: []
        }
      ])
    );

    // One membership per row, seated at the last key of the delta: 'B' sorts before 'M'.
    expect(rows.scopes.thread.read({ chatId: 'chat-1' }).map(row => row.id)).toEqual(['row-1', 'row-2']);
  });

  it('seats one membership per appended id of a sorted scope whose rows have not arrived yet', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'CommitEnvelopePlanningPlacement',
      name: 'CommitEnvelopePlanningPlacement',
      fields: { rank: f.num() },
      scopes: { list: ({ sort: { field: 'rank', dir: 'asc' } }) }
    });
    const scopeKey = getInternalScopeHandle(rows.scopes.list).key({});

    // The rows do not exist yet, so no order key can be derived from `rank`: one shared key would
    // collapse three memberships into one and the rows would never all appear.
    getApplyRuntime().commit(
      createCommitEnvelope([{ kind: 'scope-delta', model: rows.modelId, scopeKey, append: [{ id: 'ghost-a' }, { id: 'ghost-b' }, { id: 'ghost-c' }], detach: [] }])
    );

    rows.insertMany([
      { id: 'ghost-a', rank: 3 },
      { id: 'ghost-b', rank: 1 },
      { id: 'ghost-c', rank: 2 }
    ]);

    // Every membership survived, and the declared sort owns the order a reader sees.
    expect(rows.scopes.list.read({}).map(row => row.id)).toEqual(['ghost-b', 'ghost-c', 'ghost-a']);
  });

  it('[W34] plans no destroy leg when a replacement keeps its own id', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineRows('SameIdReplace');
    rows.insert({ id: 'row-1', chatId: 'chat-1', body: 'before' });

    getApplyRuntime().commit(createCommitEnvelope(getInternalModelHandle(rows).planReplace('row-1', { id: 'row-1', chatId: 'chat-1', body: 'after' })));

    // The destroy leg names only a DIFFERENT old id: replacing an identity with itself updates
    // the row and never schedules its own destruction.
    expect(rows.find('row-1')).toMatchObject({ body: 'after' });
  });

  it('[R24] gates every scope entry by the final row: a non-member append never seats', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = defineModelRuntime({
      id: 'CommitEnvelopeMemberGate',
      name: 'CommitEnvelopeMemberGate',
      fields: { chatId: f.str(), status: f.str() },
      scopes: { thread: { by: { chatId: 'chatId' }, member: (row: { status: string }) => row.status === 'active' } }
    });
    rows.scopes.thread.seed({ chatId: 'chat-1' }, [{ id: 'row-1', chatId: 'chat-1', status: 'active' }]);
    const scopeKey = compositeKey('thread', '{"chatId":"chat-1"}');

    getApplyRuntime().commit(
      createCommitEnvelope([
        {
          kind: 'upsert',
          model: rows.modelId,
          rows: [
            { id: 'row-2', chatId: 'chat-1', status: 'archived' },
            { id: 'row-3', chatId: 'chat-1', status: 'active' },
            { id: 'row-4', chatId: 'chat-2', status: 'active' }
          ]
        },
        {
          kind: 'scope-delta',
          model: rows.modelId,
          scopeKey,
          append: [
            { id: 'row-2', orderKey: 'x1' },
            { id: 'row-3', orderKey: 'x2' },
            { id: 'row-4', orderKey: 'x3' }
          ],
          detach: []
        }
      ])
    );

    // The member predicate and the derived by-value both judge the FINAL committed row: the
    // archived row and the foreign-chat row never seat, whatever the append claims.
    expect(
      rows.scopes.thread
        .read({ chatId: 'chat-1' })
        .map(row => row.id)
        .sort()
    ).toEqual(['row-1', 'row-3']);
  });

  it('[RE4] plans the full cascade before any write applies', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    type Child = { id: string; parentId: string };
    const children = defineModel('CommitEnvelopeCascadeChildren', {
      schema: defineShape<Child>()({ parentId: f.str() })
    });
    const parents = defineModel('CommitEnvelopeCascadeParents', {
      schema: defineShape<{ id: string; label: string }>()({ label: f.str() }),
      associations: () => ({
        children: hasMany<{ id: string; label: string }, Child>(children, { foreignKey: 'parentId', dependent: 'destroy' })
      })
    });
    parents.insert({ id: 'parent-1', label: 'parent' });
    children.insertMany([
      { id: 'child-1', parentId: 'parent-1' },
      { id: 'child-2', parentId: 'parent-1' }
    ]);

    const envelope = createCommitEnvelope([{ kind: 'destroy', model: parents.key, ids: ['parent-1'] }]);

    // Planning is pure: both dependent destroys are already in the envelope while every row is untouched.
    const plannedChildDestroys = envelope.entityOps.flatMap(op => (op.kind === 'destroy' && op.model === children.key ? [...op.ids] : [])).sort();
    expect(plannedChildDestroys).toEqual(['child-1', 'child-2']);
    expect(children.find('child-1')).toBeDefined();
    expect(children.find('child-2')).toBeDefined();

    getApplyRuntime().commit(envelope);

    expect(parents.find('parent-1')).toBeUndefined();
    expect(children.find('child-1')).toBeUndefined();
    expect(children.find('child-2')).toBeUndefined();
  });
});
