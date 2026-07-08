import { count as dbCount, eq, inArray } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';
import type {
  BelongsToAccessor,
  BelongsToModel,
  BelongsToRelation,
  CollectionModel,
  HasManyOptions,
  HasManyRelation,
  HasManyThroughRelation,
  ModelRelationConfigValue,
  ModelRelationDefinition,
  ModelRelationsConfig,
  RelatedAccessor,
  RowRelatedRecord,
  RowRelatedSurface,
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

type RuntimeBelongsToRelation = BelongsToRelation<StoredRowBase, string, BelongsToModel<StoredRowBase>>;

type RelatedAccessorsContext = {
  collection: CollectionModel<unknown, StoredRowBase>['collection'];
  getRow: (id: string | null | undefined) => StoredRowBase | undefined;
};

export type CascadeController = {
  modelName: string;
  attachRowRelated: <TRow extends StoredRowBase>(row: TRow) => TRow;
  destroyManyWithCascade: (ids: string[], visitedModelNames: Set<string>) => number;
  getIdsWhereFieldIn: (field: string, values: ReadonlySet<string>) => string[];
  getRelation: (name: string) => ModelRelationConfigValue | undefined;
};

const cascadeControllers = new WeakMap<object, CascadeController>();
const rowRelatedRecords = new WeakMap<object, unknown>();
let touchDepth = 0;

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

export const belongsTo = <
  TParentInput,
  TParentStored extends StoredRowBase,
  TForeignKey extends string,
  TParentModel extends CollectionModel<TParentInput, TParentStored> = CollectionModel<TParentInput, TParentStored>
>(
  model: TParentModel & CollectionModel<TParentInput, TParentStored>,
  options: { foreignKey: TForeignKey; touch?: boolean }
): BelongsToRelation<TParentStored, TForeignKey, TParentModel> => ({
  kind: 'belongsTo',
  model,
  foreignKey: options.foreignKey,
  touch: options.touch === true
});

export const relationValues = (relations: ModelRelationsConfig | undefined): ModelRelationConfigValue[] => {
  if (!relations) return [];
  return Object.values(relations);
};

const isHasManyRelation = (relation: ModelRelationConfigValue | undefined): relation is RuntimeHasManyRelation => relation?.kind === 'hasMany';
const isBelongsToRelation = (relation: ModelRelationConfigValue | undefined): relation is RuntimeBelongsToRelation => relation?.kind === 'belongsTo';

const assertDirectRelation = (
  modelName: string,
  relationName: string,
  relation: ModelRelationConfigValue | undefined,
  detail: string
): RuntimeHasManyRelation => {
  if (isHasManyRelation(relation)) return relation;
  throw new Error(`[${modelName}] relation "${relationName}" ${detail}`);
};

const attachRowsForRelation = <TChildStored extends StoredRowBase>(relation: RuntimeHasManyRelation, rows: readonly TChildStored[]): TChildStored[] => {
  const output = rows as TChildStored[];
  if (output.length === 0) return output;

  const controller = getCascadeController(relation.model);
  if (!controller) return output;

  for (const row of output) {
    controller.attachRowRelated(row);
  }
  return output;
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

  return useStableArray(attachRowsForRelation(relation, (parentId == null ? EMPTY : data ?? EMPTY) as unknown as TChildStored[]));
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
  return attachRowsForRelation(relation, relation.model.getWhere({ [relation.foreignKey]: parentId } as never) as TChildStored[]);
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

  return useStableArray(attachRowsForRelation(relation, (parentIds.length === 0 ? EMPTY : data ?? EMPTY) as unknown as TChildStored[]));
};

const getRowsByForeignKeySet = <TChildStored extends StoredRowBase>(relation: RuntimeHasManyRelation, parentIds: string[]): TChildStored[] => {
  if (parentIds.length === 0) return [];
  return attachRowsForRelation(relation, relation.model.getWhere({ or: parentIds.map(parentId => ({ [relation.foreignKey]: parentId })) } as never) as TChildStored[]);
};

const readParentId = (row: StoredRowBase | undefined, foreignKey: string): string | undefined => {
  const value = row ? (row as Record<string, unknown>)[foreignKey] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const getParentRow = <TParentStored extends StoredRowBase>(
  relation: RuntimeBelongsToRelation,
  childRow: StoredRowBase | undefined
): TParentStored | undefined => {
  const parentId = readParentId(childRow, relation.foreignKey);
  return parentId ? relation.model.get(parentId) as TParentStored | undefined : undefined;
};

const useChildRowById = (context: RelatedAccessorsContext, childId: string | null | undefined): StoredRowBase | undefined => {
  const { data } = useLiveQuery(
    q =>
      childId == null
        ? undefined
        : q
            .from({ items: context.collection })
            .where(({ items }) => eq(toQueryValue((items as Record<string, unknown>).id), childId))
            .findOne(),
    [childId]
  );

  return data as unknown as StoredRowBase | undefined;
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

const createBelongsToAccessor = <TParentStored extends StoredRowBase>(
  relation: RuntimeBelongsToRelation,
  context: RelatedAccessorsContext
): BelongsToAccessor<TParentStored> => ({
  get(childId) {
    if (childId == null) return undefined;
    return getParentRow<TParentStored>(relation, context.getRow(childId));
  },
  use(childId) {
    const childRow = useChildRowById(context, childId);
    const parentId = readParentId(childRow, relation.foreignKey);
    return relation.model.find(parentId) as TParentStored | undefined;
  }
});

export const buildRelatedAccessors = <TRelations extends ModelRelationsConfig>(
  modelName: string,
  resolveRelations: () => TRelations,
  context: RelatedAccessorsContext
): RelatedRecord<TRelations> => {
  const relations = resolveRelations();
  const related: Record<string, RelatedAccessor<StoredRowBase> | BelongsToAccessor<StoredRowBase>> = {};

  for (const [relationName, relation] of Object.entries(relations)) {
    if (isBelongsToRelation(relation)) {
      related[relationName] = createBelongsToAccessor(relation, context);
      continue;
    }
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

const buildRowRelatedRecord = <TRow extends StoredRowBase, TRelations extends ModelRelationsConfig>(
  row: TRow,
  resolveRelations: () => TRelations,
  resolveRelatedAccessors: () => RelatedRecord<TRelations>
): RowRelatedRecord<TRelations> => {
  const relatedRecord: Record<string, unknown> = {};
  const relatedAccessors = resolveRelatedAccessors();
  const relations = resolveRelations();

  for (const relationName of Object.keys(relatedAccessors)) {
    Object.defineProperty(relatedRecord, relationName, {
      enumerable: true,
      configurable: true,
      get() {
        const relation = relations[relationName];
        if (isBelongsToRelation(relation)) {
          return getParentRow(relation, row);
        }
        return (resolveRelatedAccessors() as Record<string, RelatedAccessor<StoredRowBase>>)[relationName]?.get(row.id) ?? [];
      }
    });
  }

  return relatedRecord as RowRelatedRecord<TRelations>;
};

export const attachRowRelated = <TRow extends StoredRowBase, TRelations extends ModelRelationsConfig>(
  modelName: string,
  row: TRow,
  resolveRelations: () => TRelations,
  resolveRelatedAccessors: () => RelatedRecord<TRelations>
): TRow & RowRelatedSurface<TRelations> => {
  if (Object.prototype.hasOwnProperty.call(row, 'related')) {
    return row as TRow & RowRelatedSurface<TRelations>;
  }

  if (!Object.isExtensible(row)) {
    throw new Error(`[${modelName}] cannot attach row-level relations to a non-extensible stored row.`);
  }

  Object.defineProperty(row, 'related', {
    enumerable: false,
    configurable: true,
    get() {
      let relatedRecord = rowRelatedRecords.get(row) as RowRelatedRecord<TRelations> | undefined;
      if (!relatedRecord) {
        relatedRecord = buildRowRelatedRecord(row, resolveRelations, resolveRelatedAccessors);
        rowRelatedRecords.set(row, relatedRecord);
      }
      return relatedRecord;
    }
  });

  return row as TRow & RowRelatedSurface<TRelations>;
};

export const touchBelongsToParents = (relations: ModelRelationsConfig, row: StoredRowBase | undefined): void => {
  if (!row || touchDepth > 0) return;

  const touchRelations = Object.values(relations).filter((relation): relation is RuntimeBelongsToRelation => isBelongsToRelation(relation) && relation.touch);
  if (touchRelations.length === 0) return;

  touchDepth += 1;
  try {
    const updatedAt = new Date().toISOString();
    for (const relation of touchRelations) {
      const parentId = readParentId(row, relation.foreignKey);
      if (!parentId || !relation.model.get(parentId)) continue;
      relation.model.patch(parentId, { updatedAt } as Partial<StoredRowBase>);
    }
  } finally {
    touchDepth = Math.max(0, touchDepth - 1);
  }
};
