import {
  belongsTo,
  deriveEffects,
  hasDependentCascade,
  hasMany,
  hasOne,
  readModelRelation,
  references,
  registerRelationHost
} from '../../legacyTestApi';

const target = {
  modelId: 'RelationEdgeTarget',
  find: (id: string) => (id === 'target-1' ? { id, rank: 1 } : undefined),
  all: () => [],
  where: (where: Record<string, unknown>) =>
    where.parentId === 'empty'
      ? []
      : [
          { id: 'row-b', ...where, rank: 2 },
          { id: 'row-a', ...where, rank: 1 }
        ]
};

const hostOf = (relations: Record<string, unknown>, read: (id: string) => Record<string, unknown> | undefined) =>
  ({
    modelId: 'RelationEdgeSource',
    relations: () => relations,
    read,
    membershipForUpsert: () => [],
    detachForDestroy: () => []
  }) as never;

describe('relation core edges', () => {
  it('handles missing hosts, missing rows, null ids, and every relation result shape', () => {
    expect(() => readModelRelation('RelationEdgeMissing', 'row-1', 'owner')).toThrow(
      'RelationEdgeMissing has no association owner'
    );

    const unregister = registerRelationHost(
      'RelationEdgeSource',
      hostOf(
        {
          owner: belongsTo(target, { foreignKey: 'ownerId' }),
          items: hasMany(target as never, { foreignKey: 'parentId' as never }),
          firstItem: hasOne(target as never, { foreignKey: 'parentId' as never }),
          bestItem: hasOne(target as never, {
            foreignKey: 'parentId' as never,
            comparator: (left: { rank: number }, right: { rank: number }) => left.rank - right.rank
          }),
          lastItem: hasOne(target as never, {
            foreignKey: 'parentId' as never,
            comparator: (left: { rank: number }, right: { rank: number }) => right.rank - left.rank
          }),
          refs: references(target, { ids: (row: { refId?: string | null }) => row.refId })
        },
        id => {
          if (id === 'bad-owner') return { id, ownerId: 7 };
          if (id === 'refs') return { id, refId: 'target-1' };
          if (id === 'empty-refs') return { id, refId: null };
          if (id === 'empty') return { id };
          return id === 'source-1' ? { id, ownerId: 'target-1' } : undefined;
        }
      )
    );

    try {
      expect(readModelRelation('RelationEdgeSource', null, 'items')).toEqual([]);
      expect(readModelRelation('RelationEdgeSource', null, 'refs')).toEqual([]);
      expect(readModelRelation('RelationEdgeSource', undefined, 'owner')).toBeUndefined();
      expect(readModelRelation('RelationEdgeSource', 'missing', 'items')).toEqual([]);
      expect(readModelRelation('RelationEdgeSource', 'missing', 'owner')).toBeUndefined();
      expect(readModelRelation('RelationEdgeSource', 'source-1', 'owner')).toEqual({ id: 'target-1', rank: 1 });
      expect(readModelRelation('RelationEdgeSource', 'bad-owner', 'owner')).toBeUndefined();
      expect(readModelRelation<Array<{ id: string }>>('RelationEdgeSource', 'source-1', 'items')).toHaveLength(2);
      expect(readModelRelation<{ id: string }>('RelationEdgeSource', 'source-1', 'firstItem').id).toBe('row-b');
      expect(readModelRelation('RelationEdgeSource', 'empty', 'firstItem')).toBeUndefined();
      expect(readModelRelation<{ id: string }>('RelationEdgeSource', 'source-1', 'bestItem').id).toBe('row-a');
      expect(readModelRelation<{ id: string }>('RelationEdgeSource', 'source-1', 'lastItem').id).toBe('row-b');
      expect(readModelRelation('RelationEdgeSource', 'refs', 'refs')).toEqual([{ id: 'target-1', rank: 1 }]);
      expect(readModelRelation('RelationEdgeSource', 'empty-refs', 'refs')).toEqual([]);
      expect(hasDependentCascade('RelationEdgeMissing')).toBe(false);
      expect(hasDependentCascade('RelationEdgeSource')).toBe(false);
    } finally {
      unregister();
    }
  });

  it('adapts a facade relation target and exposes its all-row reader', () => {
    const read = jest.fn(() => [{ id: 'row-1', parentId: 'parent-1' }]);
    const facade = {
      key: 'RelationEdgeFacade',
      find: jest.fn(),
      where: jest.fn(() => ({ read }))
    };
    const relation = hasMany(facade as never, { foreignKey: 'parentId' as never });

    expect(relation.model.all()).toEqual([{ id: 'row-1', parentId: 'parent-1' }]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('folds same-plan membership removal and skips empty membership deltas', () => {
    const unregister = registerRelationHost(
      'RelationEdgeMembership',
      {
        modelId: 'RelationEdgeMembership',
        relations: () => ({}),
        read: () => undefined,
        membershipForUpsert: (_before: unknown, after: { id: string }) => [
          { scopeKey: 'live', append: [after.id] },
          { scopeKey: 'empty' }
        ],
        detachForDestroy: () => []
      } as never
    );

    try {
      const effects = deriveEffects(
        [
          {
            model: 'RelationEdgeMembership',
            id: 'row-1',
            before: undefined,
            after: { id: 'row-1' },
            changedFields: null
          }
        ],
        [{ model: 'RelationEdgeMembership', id: 'row-1', before: { id: 'row-1' } }],
        [],
        { read: () => undefined, rows: () => [] }
      );

      expect(effects).toEqual([
        {
          kind: 'scope-delta',
          model: 'RelationEdgeMembership',
          scopeKey: 'live',
          append: [],
          detach: ['row-1']
        }
      ]);
    } finally {
      unregister();
    }
  });

  it('deduplicates repeated destroys and ignores invalid child foreign keys', () => {
    const childTarget = {
      modelId: 'RelationEdgeCascadeChild',
      find: jest.fn(),
      all: jest.fn(() => []),
      where: jest.fn(() => [])
    };
    const unregisterParent = registerRelationHost(
      'RelationEdgeCascadeParent',
      hostOf(
        {
          children: hasMany(childTarget, { foreignKey: 'parentId', dependent: 'destroy' })
        },
        () => undefined
      )
    );
    const unregisterChild = registerRelationHost(
      'RelationEdgeCascadeChild',
      {
        modelId: 'RelationEdgeCascadeChild',
        relations: () => ({}),
        read: () => undefined,
        membershipForUpsert: () => [],
        detachForDestroy: () => []
      } as never
    );

    try {
      expect(hasDependentCascade('RelationEdgeCascadeParent')).toBe(true);
      const effects = deriveEffects(
        [],
        [
          { model: 'RelationEdgeCascadeParent', id: 'parent-1', before: { id: 'parent-1' } },
          { model: 'RelationEdgeCascadeParent', id: 'parent-1', before: { id: 'parent-1' } }
        ],
        [],
        {
          read: () => undefined,
          rows: model => (model === 'RelationEdgeCascadeChild' ? [{ id: 'bad-child', parentId: null }] : [])
        }
      );
      expect(effects).toEqual([]);
    } finally {
      unregisterParent();
      unregisterChild();
    }
  });

  it('ignores a counter relation destroy when the destroyed row is unavailable', () => {
    const parentTarget = {
      modelId: 'RelationEdgeCounterParent',
      find: jest.fn(),
      all: jest.fn(() => []),
      where: jest.fn(() => [])
    };
    const unregister = registerRelationHost(
      'RelationEdgeCounterChild',
      hostOf(
        {
          parent: belongsTo(parentTarget, {
            foreignKey: 'parentId',
            counterCache: { field: 'count' }
          })
        },
        () => undefined
      )
    );

    try {
      expect(
        deriveEffects(
          [],
          [{ model: 'RelationEdgeCounterChild', id: 'child-1', before: undefined as never }],
          [],
          { read: () => undefined, rows: () => [] }
        )
      ).toEqual([]);
    } finally {
      unregister();
    }
  });
});
