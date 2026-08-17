import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { act } from 'react';
import {
  belongsTo,
  configureDb,
  defineModel,
  defineModelRuntime,
  defineShape,
  deriveEffects,
  f,
  hasMany,
  hasOne,
  modelRef,
  readModelRelation,
  references,
  registerRelationHost
} from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type TargetRow = { id: string; parentId?: string; rank: number };
type SourceRow = { id: string; ownerId?: string; ownerRank?: number; refId?: string | null };

describe('relation core edges', () => {
  it('reads every association kind through the facade with null ids, missing rows, and non-string foreign keys', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const Target = defineModel('SpecRelationShapeTarget', {
      schema: defineShape<TargetRow>()({ parentId: f.id().optional(), rank: f.num() })
    });
    const Source = defineModel('SpecRelationShapeSource', {
      schema: defineShape<SourceRow>()({ ownerId: f.id().optional(), ownerRank: f.num().optional(), refId: f.str().nullable() }),
      associations: () => ({
        owner: belongsTo<SourceRow, TargetRow>(Target, { foreignKey: 'ownerId' }),
        numericOwner: belongsTo<SourceRow, TargetRow>(Target, { foreignKey: 'ownerRank' }),
        items: hasMany<SourceRow, TargetRow>(Target, { foreignKey: 'parentId' }),
        firstItem: hasOne<SourceRow, TargetRow>(Target, { foreignKey: 'parentId' }),
        bestItem: hasOne<SourceRow, TargetRow>(Target, { foreignKey: 'parentId', comparator: (left, right) => left.rank - right.rank }),
        lastItem: hasOne<SourceRow, TargetRow>(Target, { foreignKey: 'parentId', comparator: (left, right) => right.rank - left.rank }),
        refs: references<SourceRow, TargetRow>(Target, { ids: source => source.refId })
      })
    });
    Target.insert({ id: 'target-1', rank: 1 });
    Target.insert({ id: 'row-a', parentId: 'source-1', rank: 2 });
    Target.insert({ id: 'row-b', parentId: 'source-1', rank: 1 });
    Source.insert({ id: 'source-1', ownerId: 'target-1' });
    Source.insert({ id: 'numeric-owner', ownerRank: 7 });
    Source.insert({ id: 'source-refs', refId: 'target-1' });
    Source.insert({ id: 'null-refs', refId: null });
    Source.insert({ id: 'childless' });

    expect(Source.items(null as never).read()).toEqual([]);
    expect(Source.refs(null as never).read()).toEqual([]);
    expect(Source.owner(undefined as never).read()).toBeUndefined();
    expect(Source.items('missing').read()).toEqual([]);
    expect(Source.owner('missing').read()).toBeUndefined();
    expect(Source.owner('source-1').read()).toEqual({ id: 'target-1', rank: 1 });
    expect(Source.numericOwner('numeric-owner').read()).toBeUndefined();
    expect(Source.items('source-1').read().map(row => row.id)).toEqual(['row-a', 'row-b']);
    expect(Source.firstItem('source-1').read()).toEqual({ id: 'row-a', parentId: 'source-1', rank: 2 });
    expect(Source.firstItem('childless').read()).toBeUndefined();
    expect(Source.bestItem('source-1').read()).toEqual({ id: 'row-b', parentId: 'source-1', rank: 1 });
    expect(Source.lastItem('source-1').read()).toEqual({ id: 'row-a', parentId: 'source-1', rank: 2 });
    expect(Source.refs('source-refs').read()).toEqual([{ id: 'target-1', rank: 1 }]);
    expect(Source.refs('null-refs').read()).toEqual([]);

    // No public surface reaches these throws: a facade only exposes declared association names, and
    // every defined model registers its relation host, so both rejections need the direct reader.
    expect(() => readModelRelation('SpecRelationShapeUnregistered', 'row-1', 'owner')).toThrow(
      'SpecRelationShapeUnregistered has no association owner'
    );
    expect(() => readModelRelation('SpecRelationShapeSource', 'source-1', 'unknownName')).toThrow(
      'SpecRelationShapeSource has no association unknownName'
    );
  });

  it('reads a facade relation target from a runtime model and resolves it through modelRef', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const FacadeChild = defineModel('SpecRelationFacadeChild', {
      schema: defineShape<{ id: string; parentId?: string; label: string }>()({ parentId: f.id().optional(), label: f.str() })
    });
    const owner = defineModelRuntime({
      id: 'SpecRelationFacadeOwner',
      name: 'SpecRelationFacadeOwner',
      fields: { label: f.str().optional() },
      relations: () => ({
        items: hasMany(FacadeChild as never, { foreignKey: 'parentId' as never })
      })
    });
    owner.insert({ id: 'owner-1' });
    FacadeChild.insert({ id: 'child-1', parentId: 'owner-1', label: 'one' });
    FacadeChild.insert({ id: 'child-2', parentId: 'owner-1', label: 'two' });

    const reader = renderCounted(() => owner.use.related('owner-1', 'items') as Array<{ id: string; label: string }>);
    expect(reader.result().map(row => row.id)).toEqual(['child-1', 'child-2']);
    act(() => {
      FacadeChild.insert({ id: 'child-3', parentId: 'owner-1', label: 'three' });
    });
    expect(reader.result().map(row => row.id)).toEqual(['child-1', 'child-2', 'child-3']);
    reader.unmount();

    const ref = modelRef<{ id: string; parentId?: string; label: string }>('SpecRelationFacadeChild');
    expect(ref.find('child-1')).toEqual({ id: 'child-1', parentId: 'owner-1', label: 'one' });
    expect(ref.where({ parentId: 'owner-1' }).map(row => row.id)).toEqual(['child-1', 'child-2', 'child-3']);
    expect(ref.all().map(row => row.id)).toEqual(['child-1', 'child-2', 'child-3']);

    // No production caller invokes the adapted all-reader on a relation declaration (effects scan
    // via the plan reader instead), so its delegation to where({}) is checked directly by value.
    const declaration = hasMany(FacadeChild as never, { foreignKey: 'parentId' as never });
    expect(declaration.model.all().map(row => (row as { id: string }).id)).toEqual(['child-1', 'child-2', 'child-3']);
  });

  it('folds a same-plan insert and destroy out of scope membership and leaves no stale entry behind', async () => {
    type ActionRow = { id: string; value: string };
    const rootDocument: TypedDocumentNode<{ fold: { root: ActionRow } }, { input: { value: string } }> = {
      kind: Kind.DOCUMENT,
      definitions: []
    };
    const transport = createMockTransport({
      mutation: async <TData,>() => ({ data: { fold: { root: { id: 'action-root-1', value: 'done' } } } }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const members = defineModelRuntime({
      id: 'SpecRelationFoldMember',
      name: 'SpecRelationFoldMember',
      fields: { bucket: f.str() },
      scopes: { live: ({ by: { bucket: 'bucket' } }) }
    });
    const Root = defineModel('SpecRelationFoldRoot', {
      schema: defineShape<ActionRow>()({ value: f.str() }),
      actions: owner => ({
        apply: owner.gql.action(rootDocument, {
          mode: 'request',
          result: 'fold',
          variables: (input: { value: string }) => ({ input }),
          root: { insert: { select: ({ data }) => data.fold.root } },
          write: (_context, plan) => {
            plan.upsert(members as never, { id: 'row-1', bucket: 'a' } as never);
            plan.upsert(members as never, { id: 'row-2', bucket: 'a' } as never);
            plan.destroy(members as never, 'row-1');
          }
        })
      })
    });

    const reader = renderCounted(() => members.scopes.live.use({ bucket: 'a' }));
    await act(async () => {
      await Root.actions.apply.run({ value: 'go' });
    });

    expect(Root.find('action-root-1')).toEqual({ id: 'action-root-1', value: 'done' });
    expect(members.find('row-1')).toBeUndefined();
    expect(members.find('row-2')).toEqual({ id: 'row-2', bucket: 'a' });
    expect(reader.result().map(row => row.id)).toEqual(['row-2']);

    // A stale entry left by a broken fold would keep row-1's old slot, so a later re-insert must
    // land at the tail behind row-3, not between row-2 and row-3.
    act(() => {
      members.insert({ id: 'row-3', bucket: 'a' });
    });
    act(() => {
      members.insert({ id: 'row-1', bucket: 'a' });
    });
    expect(reader.result().map(row => row.id)).toEqual(['row-2', 'row-3', 'row-1']);
    expect(members.scopes.live.read({ bucket: 'a' }).map(row => row.id)).toEqual(['row-2', 'row-3', 'row-1']);
    reader.unmount();

    // A model-derived membership planner always sets append or detach (createModelMembership), so
    // the empty-delta guard is reachable only with a hand-built planner: the empty delta plans
    // nothing while its sibling append in the same result still lands.
    const unregister = registerRelationHost('SpecRelationEmptyDelta', {
      modelId: 'SpecRelationEmptyDelta',
      relations: () => ({}),
      read: () => undefined,
      membershipForUpsert: (_before: unknown, after: { id: string }) => [{ scopeKey: 'noop' }, { scopeKey: 'seen', append: [after.id] }],
      detachForDestroy: () => []
    } as never);
    try {
      const effects = deriveEffects(
        [{ model: 'SpecRelationEmptyDelta', id: 'row-1', before: undefined, after: { id: 'row-1' }, changedFields: null }],
        [],
        [],
        { read: () => undefined, rows: () => [] }
      );
      expect(effects).toEqual([
        { kind: 'scope-delta', model: 'SpecRelationEmptyDelta', scopeKey: 'seen', append: [{ id: 'row-1' }], detach: [] }
      ]);
    } finally {
      unregister();
    }
  });

  it('decrements a counter once for duplicate destroys and skips children with empty foreign keys', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const parents = defineModelRuntime({
      id: 'SpecRelationDedupParent',
      name: 'SpecRelationDedupParent',
      fields: { count: f.num() }
    });
    const children = defineModelRuntime({
      id: 'SpecRelationDedupChild',
      name: 'SpecRelationDedupChild',
      fields: { parentId: f.id().nullable(), label: f.str().optional() },
      relations: () => ({
        parent: belongsTo<{ parentId: string | null }, { id: string; count: number }>(parents, {
          foreignKey: 'parentId',
          counterCache: { field: 'count' }
        })
      })
    });
    parents.insert({ id: 'p-1', count: 0 });
    children.insert({ id: 'c-1', parentId: 'p-1' });
    expect(parents.find('p-1')).toEqual({ id: 'p-1', count: 1 });
    children.insert({ id: 'c-null', parentId: null });
    expect(parents.find('p-1')).toEqual({ id: 'p-1', count: 1 });

    children.destroyMany(['c-1', 'c-1']);
    expect(parents.find('p-1')).toEqual({ id: 'p-1', count: 0 });
    expect(children.find('c-1')).toBeUndefined();
    expect(children.find('c-null')).toEqual({ id: 'c-null', parentId: null });

    const cascadeChildren = defineModelRuntime({
      id: 'SpecRelationCascadeDedupChild',
      name: 'SpecRelationCascadeDedupChild',
      fields: { parentId: f.id().nullable() }
    });
    const cascadeParents = defineModelRuntime({
      id: 'SpecRelationCascadeDedupParent',
      name: 'SpecRelationCascadeDedupParent',
      fields: { label: f.str().optional() },
      relations: () => ({
        children: hasMany(cascadeChildren, { foreignKey: 'parentId', dependent: 'destroy' })
      })
    });
    cascadeParents.insert({ id: 'P-1' });
    cascadeChildren.insert({ id: 'k-1', parentId: 'P-1' });
    cascadeChildren.insert({ id: 'k-null', parentId: null });

    cascadeParents.destroyMany(['P-1', 'P-1']);
    expect(cascadeParents.find('P-1')).toBeUndefined();
    expect(cascadeChildren.find('k-1')).toBeUndefined();
    expect(cascadeChildren.find('k-null')).toEqual({ id: 'k-null', parentId: null });

    // Belongs-to alone declares no cascade: destroying the counter parent leaves its children.
    parents.destroy('p-1');
    expect(parents.find('p-1')).toBeUndefined();
    expect(children.find('c-null')).toEqual({ id: 'c-null', parentId: null });
  });

  it('keeps a counter untouched when the destroyed child row does not exist', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const parents = defineModelRuntime({
      id: 'SpecRelationGhostParent',
      name: 'SpecRelationGhostParent',
      fields: { count: f.num() }
    });
    const children = defineModelRuntime({
      id: 'SpecRelationGhostChild',
      name: 'SpecRelationGhostChild',
      fields: { parentId: f.id().nullable() },
      relations: () => ({
        parent: belongsTo<{ parentId: string | null }, { id: string; count: number }>(parents, {
          foreignKey: 'parentId',
          counterCache: { field: 'count' }
        })
      })
    });
    parents.insert({ id: 'p-1', count: 0 });
    children.insert({ id: 'c-1', parentId: 'p-1' });
    expect(parents.find('p-1')).toEqual({ id: 'p-1', count: 1 });

    children.destroy('ghost');
    expect(children.find('ghost')).toBeUndefined();
    expect(parents.find('p-1')).toEqual({ id: 'p-1', count: 1 });

    children.destroy('c-1');
    expect(parents.find('p-1')).toEqual({ id: 'p-1', count: 0 });

    // The commit pipeline drops a destroy whose row never existed before deriveEffects runs, so
    // the undefined-before guard inside the effect deriver is reachable only by direct call.
    expect(
      deriveEffects([], [{ model: 'SpecRelationGhostChild', id: 'ghost-2', before: undefined as never }], [], {
        read: () => undefined,
        rows: () => []
      })
    ).toEqual([]);
  });
});
