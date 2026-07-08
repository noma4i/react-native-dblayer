import { count as dbCount, eq, inArray } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';
import type {
  CollectionModel,
  HasManyOptions,
  HasManyRelation,
  HasManyThroughRelation,
  ModelRelationConfigValue,
  ModelRelationDefinition,
  ModelRelationsConfig,
  RelatedAccessor,
  RelatedRecord,
  RelationModel,
  StoredRowBase,
  StringFieldKey
} from '../types';
import { useStableArray } from '../queries/base/shared';
import { toQueryValue } from '../utils/typeBoundary';

const EMPTY: readonly never[] = Object.freeze([]);

type RuntimeHasManyRelation = ModelRelationDefinition & {
  model: RelationModel<StoredRowBase>;
};

export type CascadeController = {
  modelName: string;
  destroyManyWithCascade: (ids: string[], visitedModelNames: Set<string>) => number;
  getIdsWhereFieldIn: (field: string, values: ReadonlySet<string>) => string[];
  getRelation: (name: string) => ModelRelationConfigValue | undefined;
};

const cascadeControllers = new WeakMap<object, CascadeController>();

export const registerCascadeController = (model: object, controller: CascadeController): void => {
  cascadeControllers.set(model, controller);
};

export const getCascadeController = (model: unknown): CascadeController | undefined => {
  if ((typeof model !== 'object' && typeof model !== 'function') || model === null) return undefined;
  return cascadeControllers.get(model);
};

export const hasMany = <
  TInput,
  TChildStored extends StoredRowBase,
  TForeignKey extends StringFieldKey<TChildStored>,
  TChildModel extends CollectionModel<TInput, TChildStored> = CollectionModel<TInput, TChildStored>
>(
  model: TChildModel & CollectionModel<TInput, TChildStored>,
  options: HasManyOptions<TChildStored, TForeignKey>
): HasManyRelation<TChildStored, TForeignKey, TChildModel> => ({
  kind: 'hasMany',
  model,
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

export const hasManyThrough = <TThrough extends string, TSource extends string>(options: {
  through: TThrough;
  source: TSource;
}): HasManyThroughRelation<TThrough, TSource> => ({
  kind: 'hasManyThrough',
  through: options.through,
  source: options.source
});

export const relationValues = (relations: ModelRelationsConfig | undefined): ModelRelationConfigValue[] => {
  if (!relations) return [];
  return Object.values(relations);
};

const isHasManyRelation = (relation: ModelRelationConfigValue | undefined): relation is RuntimeHasManyRelation => relation?.kind === 'hasMany';

const assertDirectRelation = (
  modelName: string,
  relationName: string,
  relation: ModelRelationConfigValue | undefined,
  detail: string
): RuntimeHasManyRelation => {
  if (isHasManyRelation(relation)) return relation;
  throw new Error(`[${modelName}] relation "${relationName}" ${detail}`);
};

const useRowsByForeignKey = <TChildStored extends StoredRowBase>(
  relation: RuntimeHasManyRelation,
  parentId: string | null | undefined
): TChildStored[] => {
  const foreignKey = relation.foreignKey;
  const { data } = useLiveQuery(
    q =>
      parentId == null
        ? undefined
        : q.from({ items: relation.model.collection }).where(({ items }) => eq(toQueryValue((items as Record<string, unknown>)[foreignKey]), parentId)),
    [foreignKey, parentId]
  );

  return useStableArray((parentId == null ? EMPTY : data ?? EMPTY) as unknown as TChildStored[]);
};

const useCountByForeignKey = (relation: RuntimeHasManyRelation, parentId: string | null | undefined): number => {
  const foreignKey = relation.foreignKey;
  const { data } = useLiveQuery(
    q =>
      parentId == null
        ? undefined
        : q
            .from({ items: relation.model.collection })
            .where(({ items }) => eq(toQueryValue((items as Record<string, unknown>)[foreignKey]), parentId))
            .groupBy(() => 1)
            .select(({ items }: { items: unknown }) => ({ total: dbCount(toQueryValue((items as Record<string, unknown>).id)) })),
    [foreignKey, parentId]
  );

  return parentId == null ? 0 : (data as Array<{ total: number }> | undefined)?.[0]?.total ?? 0;
};

const getRowsByForeignKey = <TChildStored extends StoredRowBase>(
  relation: RuntimeHasManyRelation,
  parentId: string | null | undefined
): TChildStored[] => {
  if (parentId == null) return [];
  return relation.model.getWhere({ [relation.foreignKey]: parentId } as never) as TChildStored[];
};

const useRowsByForeignKeySet = <TChildStored extends StoredRowBase>(relation: RuntimeHasManyRelation, parentIds: string[]): TChildStored[] => {
  const foreignKey = relation.foreignKey;
  const parentIdsKey = useMemo(() => parentIds.join('\u0000'), [parentIds]);
  const { data } = useLiveQuery(
    q =>
      parentIds.length === 0
        ? undefined
        : q.from({ items: relation.model.collection }).where(({ items }) => inArray(toQueryValue((items as Record<string, unknown>)[foreignKey]), parentIds)),
    [foreignKey, parentIdsKey]
  );

  return useStableArray((parentIds.length === 0 ? EMPTY : data ?? EMPTY) as unknown as TChildStored[]);
};

const getRowsByForeignKeySet = <TChildStored extends StoredRowBase>(relation: RuntimeHasManyRelation, parentIds: string[]): TChildStored[] => {
  if (parentIds.length === 0) return [];
  return relation.model.getWhere({ or: parentIds.map(parentId => ({ [relation.foreignKey]: parentId })) } as never) as TChildStored[];
};

const resolveThroughRelations = (
  modelName: string,
  relationName: string,
  relation: HasManyThroughRelation,
  relations: ModelRelationsConfig
): { throughRelation: RuntimeHasManyRelation; sourceRelation: RuntimeHasManyRelation } => {
  const throughRelation = assertDirectRelation(modelName, relationName, relations[relation.through], `hasManyThrough through "${relation.through}" must point to a direct hasMany relation.`);
  const throughController = getCascadeController(throughRelation.model);
  const sourceRelation = assertDirectRelation(
    modelName,
    relationName,
    throughController?.getRelation(relation.source),
    `hasManyThrough source "${relation.source}" must point to a direct hasMany relation on the through model.`
  );
  return { throughRelation, sourceRelation };
};

const createDirectAccessor = <TChildStored extends StoredRowBase>(relation: RuntimeHasManyRelation): RelatedAccessor<TChildStored> => ({
  get: parentId => getRowsByForeignKey<TChildStored>(relation, parentId),
  use: parentId => useRowsByForeignKey<TChildStored>(relation, parentId),
  count: parentId => useCountByForeignKey(relation, parentId)
});

const createThroughAccessor = <TChildStored extends StoredRowBase>(
  modelName: string,
  relationName: string,
  relation: HasManyThroughRelation,
  resolveRelations: () => ModelRelationsConfig
): RelatedAccessor<TChildStored> => ({
  get(parentId) {
    const { throughRelation, sourceRelation } = resolveThroughRelations(modelName, relationName, relation, resolveRelations());
    const throughIds = getRowsByForeignKey<StoredRowBase>(throughRelation, parentId).map(row => row.id);
    return getRowsByForeignKeySet<TChildStored>(sourceRelation, throughIds);
  },
  use(parentId) {
    const { throughRelation, sourceRelation } = resolveThroughRelations(modelName, relationName, relation, resolveRelations());
    const throughRows = useRowsByForeignKey<StoredRowBase>(throughRelation, parentId);
    const throughIds = useMemo(() => throughRows.map(row => row.id), [throughRows]);
    return useRowsByForeignKeySet<TChildStored>(sourceRelation, throughIds);
  },
  count(parentId) {
    const { throughRelation, sourceRelation } = resolveThroughRelations(modelName, relationName, relation, resolveRelations());
    const throughRows = useRowsByForeignKey<StoredRowBase>(throughRelation, parentId);
    const throughIds = useMemo(() => throughRows.map(row => row.id), [throughRows]);
    return useRowsByForeignKeySet<TChildStored>(sourceRelation, throughIds).length;
  }
});

export const buildRelatedAccessors = <TRelations extends ModelRelationsConfig>(
  modelName: string,
  resolveRelations: () => TRelations
): RelatedRecord<TRelations> => {
  const relations = resolveRelations();
  const related: Record<string, RelatedAccessor<StoredRowBase>> = {};

  for (const [relationName, relation] of Object.entries(relations)) {
    if (isHasManyRelation(relation)) {
      related[relationName] = createDirectAccessor(relation);
      continue;
    }
    if (relation.kind === 'hasManyThrough') {
      related[relationName] = createThroughAccessor(modelName, relationName, relation, resolveRelations);
      continue;
    }
    related[relationName] = {
      get: () => assertDirectRelation(modelName, relationName, relation, 'must be a supported relation.'),
      use: () => assertDirectRelation(modelName, relationName, relation, 'must be a supported relation.'),
      count: () => assertDirectRelation(modelName, relationName, relation, 'must be a supported relation.')
    } as unknown as RelatedAccessor<StoredRowBase>;
  }

  return related as RelatedRecord<TRelations>;
};
