import {
  compositeKey,
  configureDb,
  createCommitEnvelope,
  createModelNormalization,
  defineModelRuntime,
  f,
  getApplyRuntime,
  getApplyTarget,
  getInternalModelHandle,
  getInternalScopeHandle,
  modelRef,
  planModelLanding,
  readQuarantineEntries
} from '../../testApi';
import { act } from 'react';
import { createMemoryPlane, createMockTransport, renderCounted, settle } from '../helpers/harness';

describe('model pure helper edges', () => {
  it('applies build defaults and nullable completion without changing sparse reads', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelFieldDefaultEdges',
      name: 'ModelFieldDefaultEdges',
      fields: {
        label: f.str().default('value-default'),
        stamp: f.str().default(() => 'factory-default'),
        note: f.str().nullable()
      }
    });

    expect(model.build({ id: 'built-1' } as never)).toEqual({
      id: 'built-1',
      label: 'value-default',
      stamp: 'factory-default',
      note: null
    });

    model.insert({ id: 'sparse-1' } as never);
    expect(model.find('sparse-1')).toEqual({ id: 'sparse-1' });

    model.insert(model.build({ id: 'complete-1' } as never));
    expect(model.find('complete-1')).toEqual({
      id: 'complete-1',
      label: 'value-default',
      stamp: 'factory-default',
      note: null
    });
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

  it('[S26] rejects reserved store-plane field names at define time', () => {
    expect(() =>
      createModelNormalization({
        id: 'NormalizationReservedOrderKey',
        name: 'NormalizationReservedOrderKey',
        fields: { orderKey: f.str() }
      } as never)
    ).toThrow('NormalizationReservedOrderKey field orderKey is reserved by the store plane');

    expect(() =>
      createModelNormalization({
        id: 'NormalizationReservedDollar',
        name: 'NormalizationReservedDollar',
        fields: { $key: f.str() }
      } as never)
    ).toThrow('NormalizationReservedDollar field $key is reserved by the store plane');

    expect(() =>
      defineModelRuntime({
        id: 'RuntimeReservedOrderKey',
        name: 'RuntimeReservedOrderKey',
        fields: { orderKey: f.str() }
      })
    ).toThrow('RuntimeReservedOrderKey field orderKey is reserved by the store plane');
  });

  it('derives scope keys from stored rows, normalizes scalar values, and rejects incomplete scope values', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ScopeKeyEdges',
      name: 'ScopeKeyEdges',
      fields: {
        ownerId: f.id(),
        bucket: f.custom<string, { bucket?: string; bucketSource?: string }>(input => input.bucket ?? input.bucketSource),
        rawScope: f.str().optional()
      },
      scopes: {
        byOwner: ({ by: { owner: 'ownerId' } }),
        byBucket: ({ by: { bucket: 'bucket' } }),
        byRaw: ({ by: { raw: 'rawScope' } }),
        plainKey: ({ sort: 'server-order' })
      }
    });

    model.insert({ id: 'row-1', ownerId: 42, bucketSource: 'alpha', rawScope: 'raw' } as never);
    model.insert({ id: 'row-2', ownerId: '7', bucketSource: 'alpha' } as never);

    expect(model.find('row-1')).toEqual({ id: 'row-1', ownerId: '42', bucket: 'alpha', rawScope: 'raw' });
    expect(model.scopes.byOwner.read({ owner: 42 }).map(row => row.id)).toEqual(['row-1']);
    expect(model.scopes.byBucket.read({ bucket: 'alpha' }).map(row => row.id)).toEqual(['row-1', 'row-2']);
    expect(model.scopes.byRaw.read({ raw: 'raw' }).map(row => row.id)).toEqual(['row-1']);

    model.scopes.plainKey.seed('plain' as never, [{ id: 'row-3', ownerId: '9', bucketSource: 'beta' } as never]);
    expect(model.scopes.plainKey.read('plain' as never).map(row => row.id)).toEqual(['row-3']);

    expect(() => model.scopes.byOwner.read({} as never)).toThrow('ScopeKeyEdges.byOwner: scope value must provide owner');
  });
});

describe('model landing graph edges', () => {
  beforeEach(() => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
  });

  it('rejects an undefined sideload target and leaves the store untouched', () => {
    const root = defineModelRuntime(
      {
        id: 'LandingMissingChildRoot',
        name: 'LandingMissingChildRoot',
        fields: { label: f.str().optional() }
      },
      {
        sideloads: () => ({
          child: { model: modelRef('LandingMissingChildTarget'), select: input => (input as { child?: unknown }).child ?? null }
        })
      }
    );

    expect(() => root.insert({ id: 'root-1', child: { id: 'child-1' } } as never)).toThrow(
      'Model landing target LandingMissingChildTarget is not defined'
    );
    expect(root.all()).toEqual([]);

    root.insert({ id: 'root-2' } as never);
    expect(root.find('root-2')).toEqual({ id: 'root-2' });

    // Every runtime model with landing registers its host at define time, so an unregistered ROOT
    // is only reachable by planning against a name no model ever declared.
    expect(() => planModelLanding('MissingLandingRoot', [{ id: 'row-1' }])).toThrow('Model landing target MissingLandingRoot is not defined');
  });

  it('deduplicates a cyclic landing graph, accepts scalar rows, and routes replace through the root planner override', () => {
    const children = defineModelRuntime(
      {
        id: 'LandingGraphChildEdges',
        name: 'LandingGraphChildEdges',
        fields: { label: f.str().optional() }
      },
      {
        sideloads: () => ({
          parent: { model: modelRef('LandingGraphRootEdges'), select: input => (input as { parent?: unknown }).parent ?? null }
        })
      }
    );
    const root = defineModelRuntime(
      {
        id: 'LandingGraphRootEdges',
        name: 'LandingGraphRootEdges',
        fields: { label: f.str().optional() },
        rowId: (input: unknown) => (typeof input === 'string' ? input : undefined)
      },
      {
        sideloads: () => ({
          children: {
            model: modelRef('LandingGraphChildEdges'),
            select: input => (typeof input === 'object' && input !== null ? ((input as { children?: unknown[] }).children ?? null) : null)
          }
        })
      }
    );
    const childInput: Record<string, unknown> = { id: 'child-1', label: 'first' };
    const rootInput: Record<string, unknown> = { id: 'root-1', label: 'root', children: [childInput, childInput, null] };
    childInput.parent = rootInput;

    root.insertMany(['root-scalar', rootInput] as never[]);
    expect(root.find('root-scalar')).toEqual({ id: 'root-scalar' });
    expect(root.find('root-1')).toEqual({ id: 'root-1', label: 'root' });
    expect(children.all()).toEqual([{ id: 'child-1', label: 'first' }]);

    root.replace('root-1', { id: 'root-2', label: 'replaced', children: [{ id: 'child-2', label: 'second' }] } as never);
    expect(root.find('root-1')).toBeUndefined();
    expect(root.find('root-2')).toEqual({ id: 'root-2', label: 'replaced' });
    expect(children.find('child-2')).toEqual({ id: 'child-2', label: 'second' });
    expect(children.all().map(row => row.id).sort()).toEqual(['child-1', 'child-2']);
  });
});

describe('model write planning edges', () => {
  it('[A10] empties a scope on destroy and keeps the scope itself declared', () => {
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

  it('restores captured memberships in place under the normalized replacement id and ignores a missing patch row', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelWritePlanningEdges',
      name: 'ModelWritePlanningEdges',
      fields: { bucket: f.str(), label: f.str() },
      scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
    });
    model.scopes.byBucket.seed({ bucket: 'a' }, [
      { id: 'temp-1', bucket: 'a', label: 'old' },
      { id: 'keep-1', bucket: 'a', label: 'kept' }
    ]);
    const reader = renderCounted(() => model.scopes.byBucket.use({ bucket: 'a' }));
    expect(reader.result().map(row => row.id)).toEqual(['temp-1', 'keep-1']);

    act(() => {
      model.replace('temp-1', { id: 42, bucket: 'a', label: 'server' } as never);
    });
    expect(model.find('temp-1')).toBeUndefined();
    expect(model.find('42')).toEqual({ id: '42', bucket: 'a', label: 'server' });
    // The replacement keeps the captured slot: it lands ahead of keep-1, not appended at the tail.
    expect(reader.result().map(row => row.id)).toEqual(['42', 'keep-1']);

    act(() => {
      model.update('missing', { label: 'ignored' });
    });
    expect(model.find('missing')).toBeUndefined();
    expect(model.all().map(row => row.id).sort()).toEqual(['42', 'keep-1']);

    act(() => {
      model.update('42', { label: 'patched' });
    });
    expect(model.find('42')).toEqual({ id: '42', bucket: 'a', label: 'patched' });
    reader.unmount();
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

  it('repositions scope entries only when a patched field participates in the scope order', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const model = defineModelRuntime({
      id: 'ModelScopeOrderEdges',
      name: 'ModelScopeOrderEdges',
      fields: { bucket: f.str(), rank: f.num(), label: f.str() },
      scopes: {
        field: ({ by: { bucket: 'bucket' }, sort: { field: 'rank', dir: 'asc' } }),
        multi: ({ sort: [{ field: 'rank', dir: 'asc' }, { field: 'label', dir: 'desc' }] }),
        knownComparator: ({ sort: { comparator: (left, right) => left.rank - right.rank, orderFields: ['rank'] } }),
        unknownComparator: ({ sort: { comparator: (left, right) => String(left.label).localeCompare(String(right.label)) } })
      }
    });
    model.scopes.field.seed({ bucket: 'a' }, [
      { id: 'r-1', bucket: 'a', rank: 1, label: 'x' },
      { id: 'r-2', bucket: 'a', rank: 2, label: 'x' }
    ]);
    model.scopes.multi.seed({}, [
      { id: 'm-1', bucket: 'm', rank: 1, label: 'aa' },
      { id: 'm-2', bucket: 'm', rank: 1, label: 'bb' }
    ]);
    model.scopes.knownComparator.seed({}, [
      { id: 'k-1', bucket: 'k', rank: 1, label: 'aa' },
      { id: 'k-2', bucket: 'k', rank: 2, label: 'bb' }
    ]);
    model.scopes.unknownComparator.seed({}, [
      { id: 'u-1', bucket: 'u', rank: 1, label: 'aa' },
      { id: 'u-2', bucket: 'u', rank: 1, label: 'bb' }
    ]);
    const fieldReader = renderCounted(() => model.scopes.field.use({ bucket: 'a' }));
    const multiReader = renderCounted(() => model.scopes.multi.use({}));
    const knownReader = renderCounted(() => model.scopes.knownComparator.use({}));
    const unknownReader = renderCounted(() => model.scopes.unknownComparator.use({}));
    expect(fieldReader.result().map(row => row.id)).toEqual(['r-1', 'r-2']);
    expect(multiReader.result().map(row => row.id)).toEqual(['m-2', 'm-1']);
    expect(knownReader.result().map(row => row.id)).toEqual(['k-1', 'k-2']);
    expect(unknownReader.result().map(row => row.id)).toEqual(['u-1', 'u-2']);

    act(() => {
      model.update('r-1', { rank: 3 });
    });
    expect(fieldReader.result().map(row => row.id)).toEqual(['r-2', 'r-1']);
    act(() => {
      model.update('r-1', { label: 'y' });
    });
    expect(fieldReader.result().map(row => row.id)).toEqual(['r-2', 'r-1']);
    act(() => {
      model.update('m-1', { label: 'zz' });
    });
    expect(multiReader.result().map(row => row.id)).toEqual(['m-1', 'm-2']);
    act(() => {
      model.update('k-1', { rank: 3 });
    });
    expect(knownReader.result().map(row => row.id)).toEqual(['k-2', 'k-1']);
    act(() => {
      model.update('k-2', { label: 'other' });
    });
    expect(knownReader.result().map(row => row.id)).toEqual(['k-2', 'k-1']);
    act(() => {
      model.update('u-1', { label: 'cc' });
    });
    expect(unknownReader.result().map(row => row.id)).toEqual(['u-2', 'u-1']);
    fieldReader.unmount();
    multiReader.unmount();
    knownReader.unmount();
    unknownReader.unmount();

    // Both persistence planes acknowledge the repositioned state: the flushed snapshots carry the
    // patched row value and the scope entry order the patches produced.
    await settle(3, { macro: true });
    const decodedPayload = (key: string): unknown => JSON.parse(storage.get(key)!).payload;
    const rowKey = storage.snapshotKeys().find(key => key.startsWith('dbl:row:') && key.includes('ModelScopeOrderEdges') && key.includes('r-1'))!;
    expect(decodedPayload(rowKey)).toEqual({ id: 'r-1', bucket: 'a', rank: 3, label: 'y' });
    const scopeEntryIds = (scopeName: string): string[] => {
      const scopeStorageKey = storage.snapshotKeys().find(key => key.startsWith('dbl:scope:') && key.includes('ModelScopeOrderEdges') && key.includes(scopeName))!;
      return (decodedPayload(scopeStorageKey) as { entries: Array<{ id: string }> }).entries.map(entry => entry.id);
    };
    expect(scopeEntryIds('field')).toEqual(['r-2', 'r-1']);
    expect(scopeEntryIds('multi')).toEqual(['m-1', 'm-2']);
    expect(scopeEntryIds('knownComparator')).toEqual(['k-2', 'k-1']);
    expect(scopeEntryIds('unknownComparator')).toEqual(['u-2', 'u-1']);

    // Scope keys always derive from declared scope names, so a spec-less scope key cannot be
    // produced by any public write; the missing-spec guard is checked directly.
    const target = getApplyTarget(model.modelId);
    target.scope('7:unknown1:x', { generation: 1, coverage: 'complete', entries: [{ id: 'r-1', orderKey: 'a' }] });
    expect(target.scopeOrderAffected('7:unknown1:x', 'r-1', ['rank'])).toBe(false);
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
