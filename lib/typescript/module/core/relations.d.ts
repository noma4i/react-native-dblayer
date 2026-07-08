import type { BelongsToRelation, CollectionModel, HasManyOptions, HasManyRelation, HasManyThroughRelation, ModelRelationConfigValue, ModelRelationsConfig, RowRelatedSurface, RelatedRecord, StoredRowBase, StringFieldKey } from '../types';
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
export declare const registerCascadeController: (model: object, controller: CascadeController) => void;
export declare const getCascadeController: (model: unknown) => CascadeController | undefined;
export declare const hasMany: <TInput, TChildStored extends StoredRowBase, TForeignKey extends StringFieldKey<TChildStored>, TChildModel extends CollectionModel<TInput, TChildStored> = CollectionModel<TInput, TChildStored>>(model: TChildModel & CollectionModel<TInput, TChildStored>, options: HasManyOptions<TChildStored, TForeignKey>) => HasManyRelation<TChildStored, TForeignKey, TChildModel>;
export declare const hasManyThrough: <TThrough extends string, TSource extends string>(options: {
    through: TThrough;
    source: TSource;
}) => HasManyThroughRelation<TThrough, TSource>;
export declare const belongsTo: <TParentInput, TParentStored extends StoredRowBase, TForeignKey extends string, TParentModel extends CollectionModel<TParentInput, TParentStored> = CollectionModel<TParentInput, TParentStored>>(model: TParentModel & CollectionModel<TParentInput, TParentStored>, options: {
    foreignKey: TForeignKey;
    touch?: boolean;
}) => BelongsToRelation<TParentStored, TForeignKey, TParentModel>;
export declare const relationValues: (relations: ModelRelationsConfig | undefined) => ModelRelationConfigValue[];
export declare const buildRelatedAccessors: <TRelations extends ModelRelationsConfig>(modelName: string, resolveRelations: () => TRelations, context: RelatedAccessorsContext) => RelatedRecord<TRelations>;
export declare const attachRowRelated: <TRow extends StoredRowBase, TRelations extends ModelRelationsConfig>(modelName: string, row: TRow, resolveRelations: () => TRelations, resolveRelatedAccessors: () => RelatedRecord<TRelations>) => TRow & RowRelatedSurface<TRelations>;
export declare const touchBelongsToParents: (relations: ModelRelationsConfig, row: StoredRowBase | undefined) => void;
export {};
//# sourceMappingURL=relations.d.ts.map