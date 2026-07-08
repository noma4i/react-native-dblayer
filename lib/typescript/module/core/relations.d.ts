import type { BelongsToModel, BelongsToRelation, HasManyOptions, HasManyRelation, HasManyThroughRelation, ModelRelationConfigValue, ModelRelationsConfig, RowRelatedSurface, RelatedRecord, RelationModel, StoredRowBase, StringFieldKey } from '../types';
type RelatedAccessorsContext = {
    collection: RelationModel<StoredRowBase>['collection'];
    getRow: (id: string | null | undefined) => StoredRowBase | undefined;
};
type StoredOfRelationModel<TModel> = TModel extends {
    getAll: () => Array<infer TStored>;
} ? (TStored extends StoredRowBase ? TStored : never) : never;
type StoredOfBelongsToModel<TModel> = TModel extends {
    get: (id: string | undefined | null) => infer TStored | undefined;
} ? (TStored extends StoredRowBase ? TStored : never) : never;
export type CascadeController = {
    modelName: string;
    attachRowRelated: <TRow extends StoredRowBase>(row: TRow) => TRow;
    destroyManyWithCascade: (ids: string[], visitedModelNames: Set<string>) => number;
    getIdsWhereFieldIn: (field: string, values: ReadonlySet<string>) => string[];
    getRelation: (name: string) => ModelRelationConfigValue | undefined;
};
export declare const registerCascadeController: (model: object, controller: CascadeController) => void;
export declare const getCascadeController: (model: unknown) => CascadeController | undefined;
/**
 * Declare a direct child collection relation.
 *
 * @param model Child model whose stored rows contain the parent foreign key.
 * @param options Foreign-key field and optional dependent action.
 * @returns Relation metadata used for related accessors and cascade destroy.
 */
export declare const hasMany: <TChildModel extends RelationModel<any>, TChildStored extends StoredRowBase = StoredOfRelationModel<TChildModel>, TForeignKey extends StringFieldKey<TChildStored> = StringFieldKey<TChildStored>>(model: TChildModel, options: HasManyOptions<TChildStored, TForeignKey>) => HasManyRelation<TChildStored, TForeignKey, TChildModel>;
/**
 * Declare a query-only relation through another direct hasMany relation.
 *
 * @param options Names of the through relation and the source relation on through rows.
 * @returns Relation metadata used for composed related accessors.
 */
export declare const hasManyThrough: <TThrough extends string, TSource extends string>(options: {
    through: TThrough;
    source: TSource;
}) => HasManyThroughRelation<TThrough, TSource>;
/**
 * Declare an inverse parent relation from a child row foreign key.
 *
 * @param model Parent model read by the child foreign key.
 * @param options Foreign-key field and optional touch propagation.
 * @returns Relation metadata used for parent related accessors.
 */
export declare const belongsTo: <TParentModel extends BelongsToModel<any>, TForeignKey extends string>(model: TParentModel, options: {
    foreignKey: TForeignKey;
    touch?: boolean;
}) => BelongsToRelation<StoredOfBelongsToModel<TParentModel>, TForeignKey, TParentModel>;
export declare const relationValues: (relations: ModelRelationsConfig | undefined) => ModelRelationConfigValue[];
export declare const buildRelatedAccessors: <TRelations extends ModelRelationsConfig>(modelName: string, resolveRelations: () => TRelations, context: RelatedAccessorsContext) => RelatedRecord<TRelations>;
export declare const attachRowRelated: <TRow extends StoredRowBase, TRelations extends ModelRelationsConfig>(modelName: string, row: TRow, resolveRelations: () => TRelations, resolveRelatedAccessors: () => RelatedRecord<TRelations>) => TRow & RowRelatedSurface<TRelations>;
export declare const touchBelongsToParents: (relations: ModelRelationsConfig, row: StoredRowBase | undefined) => void;
export {};
//# sourceMappingURL=relations.d.ts.map