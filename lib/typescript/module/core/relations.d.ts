import type { AcceptedRow, DestroyedRow, JournalOp, ModelRef, RelationDecl, RelationHost } from '../types';
/**
 * Declare an inverse parent relation (child -> parent) with optional derived parent updates from event data.
 * Resolved by `deriveEffects`, which accumulates `touch` patches per parent (folding several children in one
 * plan) and `counterCache` increments/decrements, emitting them as extra `patch`/`counter` ops in the SAME
 * plan as the triggering event.
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
export declare const belongsTo: <TChild, TParent>(model: ModelRef<TParent>, options: {
    foreignKey: keyof TChild & string;
    touch?: (child: TChild, parent: TParent) => Partial<TParent> | null;
    counterCache?: {
        field: keyof TParent & string;
        filter?: (child: TChild) => boolean;
    };
}) => RelationDecl;
/**
 * Declare a direct child relation (parent -> children) whose cascade authority is explicit destroy only.
 * `deriveEffects` reads children through `model.where` after accepted entity rows commit so a cascade sees
 * children written earlier in the same plan.
 *
 * @param model The child model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.dependent `'destroy'` cascades a parent destroy to its live children in the same plan.
 * Omit for a query-only relation with no cascade. Optimistic destroy on the parent throws if this is set,
 * since a cascaded destroy cannot be rolled back.
 * @returns A hasMany relation declaration for a child-collection edge.
 */
export declare const hasMany: <_TParent, TChild>(model: ModelRef<TChild>, options: {
    foreignKey: keyof TChild & string;
    dependent?: "destroy";
}) => RelationDecl;
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
export declare const hasOne: <_TParent, TChild>(model: ModelRef<TChild>, options: {
    foreignKey: keyof TChild & string;
    comparator?: (left: TChild, right: TChild) => number;
}) => RelationDecl;
/**
 * Declare a GC-only reference edge: ids extracted from the row keep the referenced target-model rows alive
 * during garbage-collection sweeps. Not resolved by `deriveEffects` - it has no write-time side effects, only
 * a GC liveness signal (see `referencesOf` in the model's GC host registration).
 *
 * @param model The referenced model.
 * @param options.ids Extract the referenced id(s) from the row; a single id, an array, or nullish (no reference).
 * @returns A references relation declaration for GC liveness edges.
 */
export declare const references: <TChild, TRef>(model: ModelRef<TRef>, options: {
    ids: (child: TChild) => ReadonlyArray<string | null | undefined> | string | null | undefined;
}) => RelationDecl;
export declare const registerRelationHost: (modelId: string, host: RelationHost) => (() => void);
/** True when the model declares a hasMany dependent:'destroy' cascade - optimistic destroy cannot roll such a cascade back. */
export declare const hasDependentCascade: (modelId: string) => boolean;
/**
 * Derive relation effects from rows accepted by entity application. Raw journal operations never
 * contain these effects, so replay re-runs the same derivation against effective rows.
 */
export declare const deriveEffects: (accepted: AcceptedRow[], destroyedRows: DestroyedRow[], rawOps: JournalOp[]) => JournalOp[];
//# sourceMappingURL=relations.d.ts.map