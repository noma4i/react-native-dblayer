import type { BelongsToModel, BelongsToRelation, HasManyOptions, HasManyRelation, HasOneRelation, HasManyThroughRelation, ModelRelationConfigValue, ModelRelationsConfig, RowRelatedSurface, RelatedRecord, RelationModel, StoredRowBase, StringFieldKey } from '../types';
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
 * Declare a query-only single child relation.
 *
 * The relation does not participate in cascade destroy. The required comparator orders matching child
 * rows inside the parent scope, and the first row is exposed through snapshot, hook, and row-chain reads.
 *
 * @param model Child model whose stored rows contain the parent foreign key.
 * @param options Foreign-key field and required child-row comparator.
 * @returns Relation metadata used for related accessors.
 */
export declare const hasOne: <TChildModel extends RelationModel<any>, TChildStored extends StoredRowBase = StoredOfRelationModel<TChildModel>, TForeignKey extends StringFieldKey<TChildStored> = StringFieldKey<TChildStored>>(model: TChildModel, options: {
    /** Child row field that stores the parent id. */
    foreignKey: TForeignKey;
    /** Order matching child rows; the first sorted row is returned. */
    comparator: (a: TChildStored, b: TChildStored) => number;
}) => HasOneRelation<TChildStored, TForeignKey, TChildModel>;
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
 * @param options Foreign-key field, optional local-only timestamp touch, and optional full-path parent propagation.
 * @returns Relation metadata used for parent related accessors.
 */
export declare const belongsTo: <TParentModel extends BelongsToModel<any>, TForeignKey extends string, TChildStored extends StoredRowBase = StoredRowBase>(model: TParentModel, options: {
    /** Child row field that stores the parent id. */
    foreignKey: TForeignKey;
    /** Whether local child writes should bump the parent timestamp. Server writes do not touch. */
    touch?: boolean;
    /** Project each child write into a parent patch; return null when domain ordering gates reject it. */
    propagate?: (child: TChildStored, parent: StoredOfBelongsToModel<TParentModel>) => Partial<StoredOfBelongsToModel<TParentModel>> | null;
}) => BelongsToRelation<StoredOfBelongsToModel<TParentModel>, TForeignKey, TChildStored, TParentModel>;
export declare const relationValues: (relations: ModelRelationsConfig | undefined) => ModelRelationConfigValue[];
export declare const buildRelatedAccessors: <TRelations extends ModelRelationsConfig>(modelName: string, resolveRelations: () => TRelations, context: RelatedAccessorsContext) => RelatedRecord<TRelations>;
export declare const attachRowRelated: <TRow extends StoredRowBase, TRelations extends ModelRelationsConfig>(modelName: string, row: TRow, resolveRelations: () => TRelations, resolveRelatedAccessors: () => RelatedRecord<TRelations>) => TRow & RowRelatedSurface<TRelations>;
export declare const touchBelongsToParents: (relations: ModelRelationsConfig, row: StoredRowBase | undefined) => void;
export declare const propagateBelongsToParents: (relations: ModelRelationsConfig, row: StoredRowBase | undefined) => void;
export {};
//# sourceMappingURL=relations.d.ts.map