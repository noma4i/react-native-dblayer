import type { AcceptedRow, BelongsToDecl, DestroyedRow, FacadeRelationTarget, HasManyDecl, HasOneDecl, ModelRef, ReferencesDecl, RelationHost, RelationPlanReader, RelationTarget, WriteOp } from '../types';
/**
 * Declare an inverse parent relation (child -> parent) with optional derived parent updates from event data.
 * Resolved by `deriveEffects`, which accumulates `touch` patches per parent (folding several children in one
 * plan) and `counterCache` increments/decrements at plan compile time, emitting them as extra `patch`/`counter` intents
 * in the same compiled plan as the triggering event.
 *
 * @param model The parent model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.touch Derive a partial parent update from the child and current parent view; return `null`
 * to skip. Runs once per parent per plan even if several children touch it (last patch per field wins).
 * Only applies to EVENT plans - snapshot writes (queries, entity refreshes) are not expanded.
 * @param options.counterCache Increment `field` on the parent when a NEW child first references it, decrement
 * on child destroy (or on an uncommitted increment being cancelled within the same plan); `filter` restricts
 * which children count.
 * @returns A belongsTo relation declaration for a parent-model edge.
 */
export declare const belongsTo: <TChild, TParent>(model: RelationTarget<TParent>, options: {
    foreignKey: keyof TChild & string;
    touch?: (child: TChild, parent: TParent) => Partial<TParent> | null;
    counterCache?: {
        field: keyof TParent & string;
        filter?: (child: TChild) => boolean;
    };
}) => BelongsToDecl<TParent>;
/**
 * Declare a direct child relation (parent -> children) whose cascade authority is explicit destroy only.
 * `deriveEffects` reads children through the immutable plan snapshot so a cascade sees children written
 * earlier in the same plan without applying any row first.
 *
 * @param model The child model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.dependent `'destroy'` cascades a parent destroy to its live children in the same plan.
 * Omit for a query-only relation with no cascade. Optimistic destroy on the parent throws if this is set,
 * since a cascaded destroy cannot be rolled back.
 * @returns A hasMany relation declaration for a child-collection edge.
 */
export declare const hasMany: <_TParent, TChild>(model: RelationTarget<TChild>, options: {
    foreignKey: keyof TChild & string;
    dependent?: "destroy";
}) => HasManyDecl<TChild>;
/**
 * Declare a query-only single child relation (parent -> one child), read through `model.related(id, name)`.
 * Not resolved by `deriveEffects` - it has no write-time side effects, only a reactive query.
 *
 * @param model The child model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.comparator Pick the "one" child when several match; the lowest-sorting row wins. Omit to
 * use the first match in read order.
 * @returns A hasOne relation declaration for a single-child edge.
 */
export declare const hasOne: <_TParent, TChild>(model: RelationTarget<TChild>, options: {
    foreignKey: keyof TChild & string;
    comparator?: (left: TChild, right: TChild) => number;
}) => HasOneDecl<TChild>;
/**
 * Declare a reference edge by id: the row carries the target id(s) itself rather than the target carrying a
 * foreign key back. Reading the association resolves each id to its row and skips ids with no row. Not
 * resolved by `deriveEffects` - it has no write-time side effects.
 *
 * @param model The referenced model.
 * @param options.ids Extract the referenced id(s) from the row; a single id, an array, or nullish (no reference).
 * @returns A references relation declaration.
 */
export declare const references: <TChild, TRef>(model: RelationTarget<TRef>, options: {
    ids: (child: TChild) => ReadonlyArray<string | null | undefined> | string | null | undefined;
}) => ReferencesDecl<TRef>;
export declare const registerRelationTarget: <TStored>(key: string, target: FacadeRelationTarget<TStored>) => void;
/**
 * Creates a deferred, typed association target for a model identified by its persisted key.
 * Use this target when direct facade references would form a circular module or type dependency.
 *
 * @param key The target model key passed to `defineModel`.
 * @returns A model reference resolved when an association reads or plans a write.
 */
export declare const modelRef: <TStored>(key: string) => ModelRef<TStored>;
export declare const registerRelationHost: (modelId: string, host: RelationHost) => (() => void);
/**
 * Read one declared association through the same registered relation graph used by write effects.
 *
 * @param modelId Source model key.
 * @param id Source row id.
 * @param name Association name.
 * @returns One target row, an ordered target row list, or undefined.
 */
export declare const readModelRelation: <TResult = unknown>(modelId: string, id: string | null | undefined, name: string) => TResult;
/** True when the model declares a hasMany dependent:'destroy' cascade - optimistic destroy cannot roll such a cascade back. */
export declare const hasDependentCascade: (modelId: string) => boolean;
/**
 * Derive relation effects from rows accepted by pure write previews. The returned intents are compiled
 * into callback-free applied operations before the commit; the apply pipeline never invokes relation callbacks.
 */
export declare const deriveEffects: (accepted: AcceptedRow[], destroyedRows: DestroyedRow[], rawOps: WriteOp[], reader: RelationPlanReader) => WriteOp[];
//# sourceMappingURL=relations.d.ts.map