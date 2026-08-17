import { configureDb, resetRuntime, registerApplyTarget, createCommitEnvelope, createApplyRuntime, createCommitBus, createModelStore, registerModelStoreFactory, defineModelRuntime, f, getApplyRuntime, getInternalScopeHandle, hasMany, storeModelQuery, storeScopeCollection } from '../../testApi';
import type { ApplyTarget, IncrementalCommitBatch, StoredRow, WriteOp } from '../../testApi';
import { act } from 'react';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted, setupSpecRuntime } from '../helpers/harness';

/**
 * Apply-pipeline batch contracts over a mock target: entity-before-scope ordering, scope-change
 * aggregation, counter compilation, replay epoch guards, and checkpoint pruning. The mutation
 * audit left these branches unkilled (41% score) - they are the durable WAL surface that SURVIVES
 * the tanstack migration, so each guarantee is pinned here at the unit seam.
 */
const MODEL = 'SpecApplyModel';
const PREFIX = 'dbl:';

type Call = { op: string; args: unknown[] };

const createTargetMock = () => {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  const target: ApplyTarget = {
    readRow: id => rows.get(id),
    readAllRows: () => [...rows.values()],
    readScopeEntries: () => [],
    planScopePlacement: (_scopeKey, ids) => ids.map((id, index) => ({ id, orderKey: `P${index}` })),
    rowBelongsToScope: () => true,
    readScopeOrderRevision: () => 0,
    readScopeGeneration: () => 0,
    scopeOrderAffected: () => false,
    scopeSortMeta: () => ({ kind: 'server-order' }),
    compareScopeRows: () => null,
    readAllScopeKeys: () => [],
    prepareUpsert: (incoming, previous) => {
      const row: StoredRow = { ...previous, ...(incoming as StoredRow), id: String((incoming as { id: unknown }).id) };
      return { row, changedFields: previous ? Object.keys(row).filter(field => !Object.is(previous[field], row[field])) : null };
    },
    preparePatch: (id, patch, previous) => {
      if (!previous) return null;
      const row: StoredRow = { ...previous, ...patch, id };
      return { row, changedFields: Object.keys(row).filter(field => !Object.is(previous[field], row[field])) };
    },
    admitDestroy: () => true,
    beginApply: () => {},
    commitApply: () => {},
    abortApply: () => {},
    put: incoming => {
      calls.push({ op: 'put', args: [incoming] });
      return incoming.map(value => {
        const previous = rows.get(String(value.id));
        rows.set(String(value.id), value);
        return { id: String(value.id), changedFields: previous ? Object.keys(value).filter(field => !Object.is(previous[field], value[field])) : null };
      });
    },
    destroy: ids => {
      calls.push({ op: 'destroy', args: [ids] });
      for (const id of ids) rows.delete(id);
      return [...ids];
    },
    scope: scopeKey => {
      calls.push({ op: 'scope', args: [scopeKey] });
    },
    scopeDelta: (scopeKey, delta) => {
      calls.push({ op: 'scopeDelta', args: [scopeKey, delta] });
    },
    reactiveScopes: () => ['scope-1'],
    persistEntries: () => [],
    ackPersist: () => {
      calls.push({ op: 'ackPersist', args: [] });
    }
  };
  return { target, rows, calls };
};

const setup = () => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() });
  const mock = createTargetMock();
  registerApplyTarget(MODEL, mock.target);
  registerModelStoreFactory(MODEL, () =>
    createModelStore({ modelId: MODEL, now: () => Date.now(), storage, prefix: () => PREFIX, applyWriteGate: (_previous, incoming) => incoming })
  );
  const bus = createCommitBus();
  const published: IncrementalCommitBatch[] = [];
  bus.subscribeAll(batch => published.push(batch as IncrementalCommitBatch));
  return { storage, mock, bus, published };
};

describe('apply pipeline batching', () => {
  it('[I2] [ID7] [W1] stamps the only constructible envelope format and rejects it after a runtime reset', () => {
    const { storage, bus } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const envelope = createCommitEnvelope([{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }]);

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      txId: expect.any(String),
      epoch: expect.any(Number)
    });

    resetRuntime();

    expect(() => runtime.commit(envelope)).toThrow(`Stale commit envelope ${envelope.txId}`);
    expect(storage.keys(`${PREFIX}journal:`)).toEqual([]);
  });

  it('rejects an envelope with an unsupported schema before writing WAL', () => {
    const { storage, bus } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const envelope = createCommitEnvelope([]);

    expect(() => runtime.commit({ ...envelope, schemaVersion: 2 } as never)).toThrow('Unsupported commit envelope schema version 2');
    expect(storage.keys(`${PREFIX}journal:`)).toEqual([]);
  });

  it('[A14] notifies exactly the readers a commit touches, across rows, fields, scopes, models and pending state', () => {
    setupSpecRuntime();
    const rows = defineModelRuntime({
      id: 'SpecApplyBatchFanoutRows',
      name: 'SpecApplyBatchFanoutRows',
      fields: { body: f.str(), bucket: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    const others = defineModelRuntime({ id: 'SpecApplyBatchFanoutOthers', name: 'SpecApplyBatchFanoutOthers', fields: { body: f.str() } });
    rows.insertMany([
      { id: 'row-1', body: 'one', bucket: 'a' },
      { id: 'row-2', body: 'two', bucket: 'b' }
    ]);
    others.insert({ id: 'other-1', body: 'foreign' });

    const readers = {
      row1: renderCounted(() => rows.use.find('row-1')),
      row1Body: renderCounted(() => rows.use.field('row-1', 'body')),
      row1Bucket: renderCounted(() => rows.use.field('row-1', 'bucket')),
      bucketA: renderCounted(() => rows.scopes.byBucket.use({ bucket: 'a' }) as Array<{ id: string }>),
      rowsCount: renderCounted(() => rows.use.count()),
      othersRow: renderCounted(() => others.use.find('other-1'))
    };
    const capture = () => Object.fromEntries(Object.entries(readers).map(([name, reader]) => [name, reader.renders()]));
    const deltas = (before: Record<string, number>) => Object.fromEntries(Object.entries(capture()).map(([name, value]) => [name, value - before[name]!]));

    // A field patch of row-1 reaches the row reader and the field reader of THAT field only.
    let before = capture();
    act(() => {
      rows.update('row-1', { body: 'one updated' });
    });
    expect(deltas(before)).toEqual({ row1: 1, row1Body: 1, row1Bucket: 0, bucketA: 1, rowsCount: 0, othersRow: 0 });
    expect(readers.row1.result()).toMatchObject({ id: 'row-1', body: 'one updated' });
    expect(readers.row1Body.result()).toBe('one updated');
    expect(readers.bucketA.result().map(row => row.id)).toEqual(['row-1']);

    // A write to a sibling model reaches nobody reading this model.
    before = capture();
    act(() => {
      others.update('other-1', { body: 'foreign updated' });
    });
    expect(deltas(before)).toEqual({ row1: 0, row1Body: 0, row1Bucket: 0, bucketA: 0, rowsCount: 0, othersRow: 1 });
    expect(readers.othersRow.result()).toMatchObject({ body: 'foreign updated' });

    // A membership move: the scope the row leaves and the scope it joins both settle on their rows.
    before = capture();
    act(() => {
      rows.update('row-2', { bucket: 'a' });
    });
    expect(deltas(before)).toEqual({ row1: 0, row1Body: 0, row1Bucket: 0, bucketA: 1, rowsCount: 0, othersRow: 0 });
    expect(readers.bucketA.result().map(row => row.id)).toEqual(['row-1', 'row-2']);

    // A new row of the model reaches the count reader; the point readers of other rows stay put.
    before = capture();
    act(() => {
      rows.insert({ id: 'row-3', body: 'three', bucket: 'c' });
    });
    expect(deltas(before)).toEqual({ row1: 0, row1Body: 0, row1Bucket: 0, bucketA: 0, rowsCount: 1, othersRow: 0 });
    expect(readers.rowsCount.result()).toBe(3);

    for (const reader of Object.values(readers)) reader.unmount();
  });

  it('[W45] lands the row and its membership from one commit whose scope op precedes the upsert', () => {
    setupSpecRuntime();
    const model = defineModelRuntime({
      id: 'SpecApplyBatchScopeFirst',
      name: 'SpecApplyBatchScopeFirst',
      fields: { label: f.str(), bucket: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    const scope = getInternalScopeHandle(model.scopes.byBucket);
    const scopeKey = scope.key({ bucket: 'a' });
    const reader = renderCounted(() => model.scopes.byBucket.use({ bucket: 'a' }) as Array<{ id: string; label: string }>);

    act(() => {
      getApplyRuntime().commit(
        createCommitEnvelope([
          { kind: 'scope', model: model.modelId, scopeKey, next: { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: 'V' }] } },
          { kind: 'upsert', model: model.modelId, rows: [{ id: 'row-1', label: 'seated', bucket: 'a' }], origin: 'event' }
        ])
      );
    });

    expect(model.find('row-1')).toEqual({ id: 'row-1', label: 'seated', bucket: 'a' });
    expect(model.scopes.byBucket.read({ bucket: 'a' }).map(row => row.id)).toEqual(['row-1']);
    expect(storeScopeCollection(model.modelId, scopeKey).toArray().map(row => row.id)).toEqual(['row-1']);
    expect(reader.result()).toEqual([{ id: 'row-1', label: 'seated', bucket: 'a' }]);
    reader.unmount();
  });

  it('[A14] [W6] [W30] [F7] notifies a model query only after every model in the envelope reached final state', () => {
    setupSpecRuntime();
    const first = defineModelRuntime({
      id: 'SpecApplyBatchFirst',
      name: 'SpecApplyBatchFirst',
      fields: { label: f.str(), bucket: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    const scope = getInternalScopeHandle(first.scopes.byBucket);
    const projected = storeScopeCollection(first.modelId, scope.key({ bucket: 'a' }));
    const query = storeModelQuery(first.modelId, 'all', {
      where: undefined,
      orderBy: [],
      limit: undefined,
      required: []
    });
    const snapshots: Array<{ queryIds: string[]; scopeIds: Array<string | undefined> }> = [];
    const unsubscribe = query.subscribe(() => {
      snapshots.push({
        queryIds: query.rows().map(row => row.id),
        scopeIds: projected.toArray().map(row => row.id)
      });
    });

    getApplyRuntime().commit(
      createCommitEnvelope(
        scope.planApply(
          { bucket: 'a' },
          [{ row: { id: 'first', label: 'first', bucket: 'a' } }],
          'complete'
        )
      )
    );

    expect(snapshots).toEqual([{ queryIds: ['first'], scopeIds: ['first'] }]);
    unsubscribe();
    query.release();
  });

  describe('membership projection follows the op order of one envelope', () => {
    let suffix = 0;
    const setupModel = () => {
      setupSpecRuntime();
      const model = defineModelRuntime({
        id: `SpecApplyBatchProjection${(suffix += 1)}`,
        name: `SpecApplyBatchProjection${suffix}`,
        fields: { label: f.str(), bucket: f.str() },
        scopes: { byBucket: ({ by: { bucket: 'bucket' }, sort: 'server-order' }) }
      });
      const scope = getInternalScopeHandle(model.scopes.byBucket);
      const scopeKey = scope.key({ bucket: 'a' });
      const projected = storeScopeCollection(model.modelId, scopeKey);
      const memberIds = (): string[] => projected.toArray().map(row => String(row.id));
      const planeIds = (): string[] => model.scopes.byBucket.read({ bucket: 'a' }).map(row => row.id);
      return { model, scopeKey, memberIds, planeIds };
    };

    it('[W45] [scope without X, delta append X with its previous key] leaves X in the collection', () => {
      const { model, scopeKey, memberIds, planeIds } = setupModel();
      model.insertMany([
        { id: 'x', label: 'x', bucket: 'a' },
        { id: 'y', label: 'y', bucket: 'a' }
      ]);
      getApplyRuntime().commit(
        createCommitEnvelope([
          { kind: 'scope', model: model.modelId, scopeKey, next: { generation: 2, coverage: 'complete', entries: [{ id: 'x', orderKey: '1' }, { id: 'y', orderKey: '2' }] } }
        ])
      );
      expect(memberIds()).toEqual(['x', 'y']);

      getApplyRuntime().commit(
        createCommitEnvelope([
          { kind: 'scope', model: model.modelId, scopeKey, next: { generation: 3, coverage: 'complete', entries: [{ id: 'y', orderKey: '2' }] } },
          { kind: 'scope-delta', model: model.modelId, scopeKey, append: [{ id: 'x', orderKey: '1' }], detach: [] }
        ])
      );

      expect(memberIds()).toEqual(['x', 'y']);
      expect(memberIds()).toEqual(planeIds());
    });

    it('[W45] [scope with X, delta detach X] leaves X out of the collection', () => {
      const { model, scopeKey, memberIds, planeIds } = setupModel();
      model.insertMany([
        { id: 'x', label: 'x', bucket: 'a' },
        { id: 'y', label: 'y', bucket: 'a' }
      ]);
      getApplyRuntime().commit(
        createCommitEnvelope([
          { kind: 'scope', model: model.modelId, scopeKey, next: { generation: 2, coverage: 'complete', entries: [{ id: 'y', orderKey: '2' }] } }
        ])
      );
      expect(memberIds()).toEqual(['y']);

      getApplyRuntime().commit(
        createCommitEnvelope([
          { kind: 'scope', model: model.modelId, scopeKey, next: { generation: 3, coverage: 'complete', entries: [{ id: 'x', orderKey: '1' }, { id: 'y', orderKey: '2' }] } },
          { kind: 'scope-delta', model: model.modelId, scopeKey, append: [], detach: ['x'] }
        ])
      );

      expect(memberIds()).toEqual(['y']);
      expect(memberIds()).toEqual(planeIds());
    });
  });

  it('normalizes non-string ids across upsert, patch, and destroy so one overlay identity survives the batch', () => {
    setupSpecRuntime();
    const model = defineModelRuntime({ id: 'SpecApplyBatchNumericId', name: 'SpecApplyBatchNumericId', fields: { label: f.str() } });

    // A numeric upsert id and a numeric patch id address the SAME planned row within one envelope.
    getApplyRuntime().commit(
      createCommitEnvelope([
        { kind: 'upsert', model: model.modelId, rows: [{ id: 42, label: 'landed' }] },
        { kind: 'patch', model: model.modelId, id: 42 as never, patch: { label: 'patched' } }
      ])
    );
    expect(model.find('42')).toEqual({ id: '42', label: 'patched' });
    expect(model.all().map(row => row.id)).toEqual(['42']);

    // A numeric destroy id resolves to the same stored identity.
    getApplyRuntime().commit(createCommitEnvelope([{ kind: 'destroy', model: model.modelId, ids: [42 as never] }]));
    expect(model.find('42')).toBeUndefined();
    expect(model.all()).toEqual([]);
  });

  it('compiles chained counters into one callback-free effective row plan', () => {
    const { storage, mock, bus } = setup();
    mock.rows.set('row-1', { id: 'row-1', likes: 10, views: 94 });
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: WriteOp[] = [
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'likes', delta: 2 },
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'likes', delta: 3 },
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'views', delta: 5 },
      { kind: 'counter', model: MODEL, id: 'row-2', field: 'likes', delta: 1 }
    ];

    runtime.commit(createCommitEnvelope(ops));

    // Chained counters compile against the plan overlay: the applied row carries every delta once.
    expect(mock.rows.get('row-1')).toEqual({ id: 'row-1', likes: 15, views: 99 });
    expect(mock.rows.has('row-2')).toBe(false);
  });

  it('[RE40] skips counter ops with nullable, numeric-string, and nonnumeric bases without fabricating a base', () => {
    const { mock } = setup();
    mock.rows.set('null-row', { id: 'null-row', score: null });
    mock.rows.set('string-row', { id: 'string-row', score: '4' });
    mock.rows.set('invalid-row', { id: 'invalid-row', score: 'invalid' });
    diagnostics().reset();

    const envelope = createCommitEnvelope([
      { kind: 'counter', model: MODEL, id: 'null-row', field: 'score', delta: 2 },
      { kind: 'counter', model: MODEL, id: 'string-row', field: 'score', delta: 3 },
      { kind: 'counter', model: MODEL, id: 'invalid-row', field: 'score', delta: 5 }
    ]);

    expect(envelope.entityOps).toEqual([]);
    expect(diagnostics().snapshot().counterOpDrops).toBe(3);
  });

  it('throws on a committed upsert row without a usable id and writes nothing, then lands a valid row', () => {
    setupSpecRuntime();
    const model = defineModelRuntime({ id: 'SpecApplyBatchNoId', name: 'SpecApplyBatchNoId', fields: { label: f.str() } });

    expect(() => getApplyRuntime().commit(createCommitEnvelope([{ kind: 'upsert', model: model.modelId, rows: [{ label: 'orphan' }] }]))).toThrow(
      'SpecApplyBatchNoId requires id'
    );
    expect(model.all()).toEqual([]);

    getApplyRuntime().commit(createCommitEnvelope([{ kind: 'upsert', model: model.modelId, rows: [{ id: 'row-1', label: 'kept' }] }]));
    expect(model.all()).toEqual([{ id: 'row-1', label: 'kept' }]);
  });

  it('drops invalid raw shapes from a landing while the valid row of the same landing lands', () => {
    setupSpecRuntime();
    const model = defineModelRuntime({ id: 'SpecApplyBatchRawShapes', name: 'SpecApplyBatchRawShapes', fields: { label: f.str() } });

    model.insertMany([null, {}, 17, 'raw', { id: 'good', label: 'kept' }] as never[]);

    expect(model.all()).toEqual([{ id: 'good', label: 'kept' }]);
  });

  it('folds the merge base into a replacement upsert only, never into an event upsert', () => {
    setupSpecRuntime();
    const model = defineModelRuntime({ id: 'SpecApplyBatchMergeBase', name: 'SpecApplyBatchMergeBase', fields: { label: f.str(), note: f.str() } });

    // The public identity swap: fields the server response omits survive from the temp row.
    model.insert({ id: 'temp-1', label: 'temp', note: 'keep-note' });
    model.replace('temp-1', { id: 'server-1', label: 'server' });
    expect(model.find('temp-1')).toBeUndefined();
    expect(model.find('server-1')).toEqual({ id: 'server-1', label: 'server', note: 'keep-note' });

    // An event upsert carrying a smuggled merge base ignores it: only its own fields land.
    getApplyRuntime().commit(
      createCommitEnvelope([
        { kind: 'upsert', model: model.modelId, rows: [{ id: 'event-row', label: 'live' }], origin: 'event', mergeBase: { id: 'event-row', note: 'wrong-base' } } as unknown as WriteOp
      ])
    );
    expect(model.find('event-row')).toEqual({ id: 'event-row', label: 'live' });
  });

  it('cascades a dependent destroy over the row overlay, catching a child upserted in the same envelope', () => {
    // The malformed-stored-id branch of the old planner test is unreachable through a real model:
    // entityState coerces every stored id to a string on put and hydrate quarantines non-string ids.
    setupSpecRuntime();
    const children = defineModelRuntime({ id: 'SpecApplyCascadeChildren', name: 'SpecApplyCascadeChildren', fields: { parentId: f.str(), label: f.str() } });
    const parents = defineModelRuntime({
      id: 'SpecApplyCascadeParents',
      name: 'SpecApplyCascadeParents',
      fields: { name: f.str() },
      relations: () => ({ children: hasMany(children, { foreignKey: 'parentId', dependent: 'destroy' }) })
    });
    parents.insertMany([
      { id: 'parent-1', name: 'doomed' },
      { id: 'parent-2', name: 'alive' }
    ]);
    children.insertMany([
      { id: 'old-child', parentId: 'parent-1', label: 'stored' },
      { id: 'other-child', parentId: 'parent-2', label: 'foreign' }
    ]);

    getApplyRuntime().commit(
      createCommitEnvelope([
        { kind: 'upsert', model: children.modelId, rows: [{ id: 'new-child', parentId: 'parent-1', label: 'fresh' }] },
        { kind: 'destroy', model: parents.modelId, ids: ['parent-1'] }
      ])
    );

    expect(parents.find('parent-1')).toBeUndefined();
    expect(children.find('old-child')).toBeUndefined();
    expect(children.find('new-child')).toBeUndefined();
    expect(children.all()).toEqual([{ id: 'other-child', parentId: 'parent-2', label: 'foreign' }]);
  });

  it('commits a target that does not expose reactive scopes', () => {
    const model = 'SpecApplyWithoutReactiveScopes';
    const mock = createTargetMock();
    delete mock.target.reactiveScopes;
    registerApplyTarget(model, mock.target);
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    registerApplyTarget(model, mock.target);
    registerModelStoreFactory(model, () =>
      createModelStore({ modelId: model, now: () => Date.now(), storage, prefix: () => PREFIX, applyWriteGate: (_previous, incoming) => incoming })
    );
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus: createCommitBus() });

    runtime.commit(createCommitEnvelope([{ kind: 'upsert', model, rows: [{ id: 'row-1' }] }]));

    expect(mock.rows.get('row-1')).toEqual({ id: 'row-1' });
  });

  it('[A4] [A12] [W29] applies a multi-op multi-model envelope as one batch: each reader renders once with the final state', () => {
    setupSpecRuntime();
    const first = defineModelRuntime({ id: 'SpecApplyLifecycleFirst', name: 'SpecApplyLifecycleFirst', fields: { label: f.str() } });
    const second = defineModelRuntime({ id: 'SpecApplyLifecycleSecond', name: 'SpecApplyLifecycleSecond', fields: { label: f.str() } });
    first.insert({ id: 'row-1', label: 'start' });
    const firstRow = renderCounted(() => first.use.find('row-1'));
    const firstCount = renderCounted(() => first.use.count());
    const secondCount = renderCounted(() => second.use.count());
    const before = { firstRow: firstRow.renders(), firstCount: firstCount.renders(), secondCount: secondCount.renders() };

    act(() => {
      getApplyRuntime().commit(
        createCommitEnvelope([
          { kind: 'upsert', model: first.modelId, rows: [{ id: 'row-1', label: 'updated' }], origin: 'event' },
          { kind: 'upsert', model: first.modelId, rows: [{ id: 'row-2', label: 'new' }], origin: 'event' },
          { kind: 'upsert', model: second.modelId, rows: [{ id: 'other-1', label: 'sibling' }], origin: 'event' }
        ])
      );
    });

    expect(firstRow.renders() - before.firstRow).toBe(1);
    expect(firstRow.result()).toEqual({ id: 'row-1', label: 'updated' });
    expect(firstCount.renders() - before.firstCount).toBe(1);
    expect(firstCount.result()).toBe(2);
    expect(secondCount.renders() - before.secondCount).toBe(1);
    expect(secondCount.result()).toBe(1);
    firstRow.unmount();
    firstCount.unmount();
    secondCount.unmount();
  });
});
