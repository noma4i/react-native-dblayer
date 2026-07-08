import type {
  CollectionModel,
  HasManyOptions,
  HasManyRelation,
  ModelRelationDefinition,
  ModelRelationsConfig,
  StoredRowBase,
  StringFieldKey
} from '../types';

export type CascadeController = {
  modelName: string;
  destroyManyWithCascade: (ids: string[], visitedModelNames: Set<string>) => number;
  getIdsWhereFieldIn: (field: string, values: ReadonlySet<string>) => string[];
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
  TForeignKey extends StringFieldKey<TChildStored>
>(
  model: CollectionModel<TInput, TChildStored>,
  options: HasManyOptions<TChildStored, TForeignKey>
): HasManyRelation<TChildStored, TForeignKey> => ({
  kind: 'hasMany',
  model,
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

export const relationValues = (relations: ModelRelationsConfig | undefined): ModelRelationDefinition[] => {
  if (!relations) return [];
  return Object.values(relations);
};
