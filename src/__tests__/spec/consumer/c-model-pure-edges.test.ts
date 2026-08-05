import {
  compositeKey,
  configureDb,
  createCommitEnvelope,
  createModelNormalization,
  createModelScopeKeys,
  defineModelRuntime,
  f,
  firstCompositeKeyPart,
  getApplyRuntime,
  getApplyTarget,
  getInternalModelHandle,
  getInternalScopeHandle,
  planModelLanding,
  planModelLandingWithRoot,
  readModelField,
  readQuarantineEntries,
  registerModelLandingHost,
  type ModelLandingHost,
  type WriteOp
} from '../../testApi';
import { act } from 'react';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

const createLandingHost = (model: string, sideloads?: ModelLandingHost['sideloads']): ModelLandingHost => ({
  admitPlanRow: input => {
    if (typeof input === 'string') return { id: input };
    const id = (input as { id?: unknown }).id;
    return typeof id === 'string' ? { id } : undefined;
  },
  planOwnRows: (rows, options) => [{ kind: 'upsert', model, rows: rows as Array<Record<string, unknown>>, ...(options?.origin ? { origin: options.origin } : {}) }],
  sideloads
});

describe('model pure helper edges', () => {
  it('applies build defaults and nullable completion without changing sparse reads', () => {
    const valueDefault = f.str().default('value-default');
    const factoryDefault = f.str().default(() => 'factory-default');
    const nullable = f.str().nullable();

    expect(readModelField(valueDefault, {}, 'value', true)).toBe('value-default');
    expect(readModelField(factoryDefault, {}, 'value', true)).toBe('factory-default');
    expect(readModelField(nullable, {}, 'value', true)).toBeNull();
    expect(readModelField(nullable, {}, 'value', false)).toBeUndefined();
  });

  it('validates write-group and guard declarations before accepting rows', () => {
    expect(() =>
      createModelNormalization({
        id: 'NormalizationEmptyGroups',
        name: 'NormalizationEmptyGroups',
        fields: { label: f.str() },
        write: {}
      } as never)
    ).toThrow('NormalizationEmptyGroups write groups must not be empty');

    const guarded = createModelNormalization({
      id: 'NormalizationGuarded',
      name: 'NormalizationGuarded',
      fields: { label: f.str() },
      guard: () => false
    } as never);
    expect(() => guarded.normalize({ id: 'row-1', label: 'blocked' })).toThrow('NormalizationGuarded rejected input');

    const scalar = createModelNormalization({
      id: 'NormalizationScalar',
      name: 'NormalizationScalar',
      fields: {},
      rowId: (input: unknown) => input
    } as never);
    expect(scalar.normalize(42)).toEqual({ id: '42' });

    const fallback = createModelNormalization({
      id: 'NormalizationRowIdFallback',
      name: 'NormalizationRowIdFallback',
      fields: {},
      rowId: () => undefined
    } as never);
    expect(fallback.normalize({ id: 'fallback-id' })).toEqual({ id: 'fallback-id' });
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    expect(fallback.admitPlanRow({})).toBeUndefined();
    expect(readQuarantineEntries()).toContainEqual(expect.objectContaining({ kind: 'row', model: 'NormalizationRowIdFallback', reason: 'plan-row-rejected' }));
  });

  it('derives scope values without re-reading stored custom fields and normalizes scalar keys', () => {
    const fields = {
      ownerId: f.id(),
      bucket: f.custom<string, { bucket: string }>(input => input.bucket),
      rawScope: f.str()
    };
    const helpers = createModelScopeKeys(
      { name: 'ScopeKeyEdges', fields },
      new Map<string, Record<string, string>>([
        ['byOwner', { owner: 'ownerId' }],
        ['byBucket', { bucket: 'bucket' }],
        ['byRaw', { raw: 'missingField' }]
      ])
    );

    expect(helpers.scopeValueFromRow({ bucket: 'bucket' }, { id: 'row-1', bucket: 'stored' })).toEqual({ bucket: 'stored' });
    expect(helpers.scopeValueFromRow({ raw: 'missingField' }, { id: 'row-1', missingField: 'raw' })).toEqual({ raw: 'raw' });
    expect(helpers.scopeValueFromRow({ raw: 'missingField' }, { id: 'row-1' })).toBeNull();
    expect(helpers.keyForScope('byOwner', { owner: 42 })).toContain('"42"');
    expect(helpers.keyForScope('unknown', 'plain')).toBeDefined();
    expect(() => helpers.keyForScope('byOwner', {})).toThrow('ScopeKeyEdges.byOwner: scope value must provide owner');
  });
});

describe('model landing graph edges', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
  });

  it('rejects undefined root and sideload targets', () => {
    expect(() => planModelLanding('MissingLandingRoot', [{ id: 'row-1' }])).toThrow('Model landing target MissingLandingRoot is not defined');

    const root = 'LandingMissingChildRoot';
    registerModelLandingHost(
      root,
      createLandingHost(root, () => ({
        child: { model: { key: 'LandingMissingChild' }, select: () => ({ id: 'child-1' }) }
      }))
    );
    expect(() => planModelLanding(root, [{ id: 'root-1' }])).toThrow('Model landing target LandingMissingChild is not defined');
  });

  it('deduplicates repeated edges, accepts scalar rows, and supports a root planner override', () => {
    const root = 'LandingGraphRootEdges';
    const child = 'LandingGraphChildEdges';
    const shared = { id: 'child-1' };
    const childRef = { modelId: child, find: () => undefined, all: () => [], where: () => [] };
    registerModelLandingHost(child, createLandingHost(child));
    registerModelLandingHost(
      root,
      createLandingHost(root, () => ({
        many: { model: { key: child }, select: input => (typeof input === 'string' ? null : [shared, shared, null]) },
        one: { model: childRef, select: () => shared }
      }))
    );
    const planRoot = jest.fn(
      (rows: unknown[], options?: { origin?: 'event' }): WriteOp[] => [
        { kind: 'upsert', model: root, rows: rows as Array<Record<string, unknown>>, ...(options?.origin ? { origin: options.origin } : {}) }
      ]
    );

    const plan = planModelLandingWithRoot(root, ['root-scalar', { id: 'root-1' }], planRoot, { origin: 'event' });

    expect(planRoot).toHaveBeenCalledWith(['root-scalar', { id: 'root-1' }], { origin: 'event' });
    expect(plan).toContainEqual({ kind: 'upsert', model: child, rows: [shared], origin: 'event' });
  });
});

describe('model write planning edges', () => {
  it('empties a scope on destroy and keeps the scope itself declared', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelGcStaleScopeMember',
      name: 'ModelGcStaleScopeMember',
      fields: { bucket: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    model.scopes.byBucket.seed({ bucket: 'a' }, [{ id: 'row-1', bucket: 'a' }]);
    const target = getApplyTarget(model.modelId);

    model.destroy('row-1');

    // Destroy detaches membership in the same act, so no later pass has stale entries to sweep. The
    // scope key stays: an empty scope the app has read means "known to hold nothing", which is not
    // the same answer as a scope that was never fetched.
    const scopeKey = compositeKey('byBucket', '{"bucket":"a"}');
    expect(target.readAllScopeKeys()).toEqual([scopeKey]);
    expect(target.readScopeEntries(scopeKey)).toEqual([]);
    expect(model.all()).toEqual([]);
  });

  it('restores captured memberships under the normalized replacement id and ignores a missing patch row', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelWritePlanningEdges',
      name: 'ModelWritePlanningEdges',
      fields: { bucket: f.str(), label: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    model.scopes.byBucket.seed({ bucket: 'a' }, [{ id: 'old-id', bucket: 'a', label: 'old' }]);
    const handle = getInternalModelHandle(model);
    const memberships = handle.captureMembership('old-id');

    expect(handle.readRow('old-id')).toMatchObject({ id: 'old-id', label: 'old' });
    handle.applyRows([{ id: 'applied-id', bucket: 'b', label: 'applied' }]);
    expect(model.find('applied-id')).toMatchObject({ id: 'applied-id', label: 'applied' });
    expect(handle.planRestore({ id: 'new-id', bucket: 'a', label: 'new' }, memberships)).toEqual([
      { kind: 'upsert', model: model.modelId, rows: [{ id: 'new-id', bucket: 'a', label: 'new' }], origin: 'event' },
      {
        kind: 'scope-delta',
        model: model.modelId,
        scopeKey: memberships[0]!.scopeKey,
        append: [{ id: 'new-id', orderKey: memberships[0]!.orderKey }],
        detach: ['old-id']
      }
    ]);

    handle.applyPatch('missing', { label: 'ignored' });
    expect(model.find('missing')).toBeUndefined();
  });

  it('keeps a same-id membership when restoring a captured row', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelWritePlanningSameId',
      name: 'ModelWritePlanningSameId',
      fields: { bucket: f.str(), label: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    model.scopes.byBucket.seed({ bucket: 'a' }, [{ id: 'same-id', bucket: 'a', label: 'old' }]);
    const handle = getInternalModelHandle(model);
    const memberships = handle.captureMembership('same-id');
    const scopeReader = renderCounted(() => model.scopes.byBucket.use({ bucket: 'a' }));
    handle.applyPatch('same-id', { label: 'pending' });
    const plan = handle.planRestore({ id: 'same-id', bucket: 'a', label: 'restored' }, memberships);

    await act(async () => {
      getApplyRuntime().commit(createCommitEnvelope(plan));
    });

    const rows = scopeReader.result();
    scopeReader.unmount();
    expect({ plan, rows }).toEqual({
      plan: [
        { kind: 'upsert', model: model.modelId, rows: [{ id: 'same-id', bucket: 'a', label: 'restored' }], origin: 'event' },
        {
          kind: 'scope-delta',
          model: model.modelId,
          scopeKey: memberships[0]!.scopeKey,
          append: [{ id: 'same-id', orderKey: memberships[0]!.orderKey }],
          detach: []
        }
      ],
      rows: [{ id: 'same-id', bucket: 'a', label: 'restored' }]
    });
  });

  it('classifies scope order dependencies and acknowledges both persistence planes', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelApplyTargetEdges',
      name: 'ModelApplyTargetEdges',
      fields: { bucket: f.str(), rank: f.num(), label: f.str() },
      scopes: {
        field: ({ by: { bucket: 'bucket' }, sort: { field: 'rank', dir: 'asc' } }),
        multi: ({ sort: [{ field: 'rank', dir: 'asc' }, { field: 'label', dir: 'desc' }] }),
        knownComparator: ({
          sort: {
            comparator: (left, right) => left.rank - right.rank,
            orderFields: ['rank']
          }
        }),
        unknownComparator: ({ sort: { comparator: (left, right) => left.rank - right.rank } })
      }
    });
    const row = { id: 'row-1', bucket: 'bucket-1', rank: 1, label: 'one' };
    model.scopes.field.seed({ bucket: 'bucket-1' }, [row]);
    model.scopes.multi.seed({}, [row]);
    model.scopes.knownComparator.seed({}, [row]);
    model.scopes.unknownComparator.seed({}, [row]);
    const target = getApplyTarget(model.modelId);
    const keys = Object.fromEntries(target.readAllScopeKeys().map(scopeKey => [firstCompositeKeyPart(scopeKey), scopeKey]));

    expect(target.scopeOrderAffected(keys.field!, 'row-1', null)).toBe(true);
    expect(target.scopeOrderAffected(keys.field!, 'missing', ['label'])).toBe(true);
    expect(target.scopeOrderAffected(keys.field!, 'row-1', ['bucket'])).toBe(true);
    expect(target.scopeOrderAffected(keys.field!, 'row-1', ['label'])).toBe(false);
    expect(target.scopeOrderAffected(keys.multi!, 'row-1', ['label'])).toBe(true);
    expect(target.scopeOrderAffected(keys.knownComparator!, 'row-1', ['label'])).toBe(false);
    expect(target.scopeOrderAffected(keys.knownComparator!, 'row-1', ['rank'])).toBe(true);
    expect(target.scopeOrderAffected(keys.unknownComparator!, 'row-1', ['label'])).toBe(true);

    const unknownKey = '7:unknown1:x';
    target.scope(unknownKey, { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: 'a' }] });
    expect(target.scopeOrderAffected(unknownKey, 'row-1', ['rank'])).toBe(false);
    expect(target.persistEntries()).not.toEqual([]);
    target.ackPersist();
    expect(target.persistEntries()).toEqual([]);
  });

  it('rejects statics that collide with the base model surface', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });

    expect(() =>
      defineModelRuntime({
        id: 'ModelStaticCollision',
        name: 'ModelStaticCollision',
        fields: { label: f.str() },
        statics: () => ({ find: () => undefined })
      })
    ).toThrow('ModelStaticCollision statics collide with base model key find');
  });

  it('plans filtered sorted scopes across reset, delta, placement, and stale membership states', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelScopePlannerEdges',
      name: 'ModelScopePlannerEdges',
      fields: { bucket: f.str(), rank: f.num(), label: f.str() },
      scopes: {
        filtered: ({
          by: { bucket: 'bucket' },
          member: row => row.label !== 'skip',
          sort: { field: 'rank', dir: 'asc' },
          retention: { maxRows: 2 }
        }),
        server: ({ sort: 'server-order' })
      }
    });
    const filtered = getInternalScopeHandle(model.scopes.filtered);
    const server = getInternalScopeHandle(model.scopes.server);
    const scopeValue = { bucket: 'a' };
    model.scopes.filtered.seed(scopeValue, [
      { id: 'old-1', bucket: 'a', rank: 1, label: 'one' },
      { id: 'old-2', bucket: 'a', rank: 2, label: 'two' }
    ]);
    const target = getApplyTarget(model.modelId);

    expect(filtered.isServerOrder()).toBe(false);
    expect(server.isServerOrder()).toBe(true);
    expect(filtered.isResolved(scopeValue)).toBe(true);
    expect(filtered.readRows(scopeValue).map(row => row.id)).toEqual(['old-1', 'old-2']);
    expect(() => filtered.noteAccess(scopeValue)).not.toThrow();
    expect(filtered.planPlacement(scopeValue, 'prepend', 'prepend')).toHaveLength(1);
    expect(filtered.planPlacement(scopeValue, 'append', 'append')).toHaveLength(1);
    const scopeKey = target.readAllScopeKeys()[0]!;
    const ghostPlacement = filtered.planPlacement(scopeValue, 'ghost', 'append')[0]!;
    if (ghostPlacement.kind !== 'scope-delta') throw new Error('Expected scope delta placement');
    target.scopeDelta(scopeKey, { append: ghostPlacement.append as Array<{ id: string; orderKey: string }>, detach: [] });
    expect(() => filtered.planApply(scopeValue, [{ row: { id: 'new-anchor', bucket: 'a', rank: 3, label: 'anchor' } }], 'delta')).toThrow(
      'Invalid scope index value'
    );
    target.scopeDelta(scopeKey, { append: [], detach: ['ghost'] });
    const filteredPlan = filtered.planApply(
      scopeValue,
      [
        { row: { id: 'skip', bucket: 'a', rank: 3, label: 'skip' } },
        { row: { id: 'missing-bucket', rank: 4, label: 'four' } }
      ],
      'delta'
    );
    expect(filteredPlan).toHaveLength(2);
    expect(filteredPlan.flatMap(op => (op.kind === 'scope' ? op.next.entries.map(entry => entry.id) : []))).toEqual(['old-1', 'old-2']);

    target.beginApply(getApplyRuntime().currentEpoch() + 1);
    target.destroy(['old-1']);
    target.commitApply();
    filtered.apply(
      scopeValue,
      [
        { id: 'old-2', bucket: 'a', rank: 2, label: 'two' },
        { id: 'new-3', bucket: 'a', rank: 3, label: 'three' }
      ],
      'page',
      { resetOrder: true }
    );
    filtered.apply(
      scopeValue,
      [
        { id: 'old-2', bucket: 'a', rank: 2, label: 'two' },
        { id: 'new-0', bucket: 'a', rank: 0, label: 'zero' }
      ],
      'delta'
    );

    expect(filtered.readRows(scopeValue).map(row => row.id)).toEqual(['new-0', 'old-2', 'new-3']);
  });
});
