import type { JournalOp } from './apply/journal';
/** Structural reference to a defined model; relation thunks resolve it after both models exist. */
export type ModelRef<TStored> = {
    modelId: string;
    get(id: string | null | undefined): TStored | undefined;
    getWhere(where: Record<string, unknown>): TStored[];
};
type StoredRow = Record<string, unknown>;
type TouchFn = (child: StoredRow, parent: StoredRow) => StoredRow | null;
export type RelationDecl = {
    kind: 'belongsTo';
    model: ModelRef<StoredRow>;
    foreignKey: string;
    touch?: TouchFn;
    counterCache?: {
        field: string;
        filter?: (child: StoredRow) => boolean;
    };
} | {
    kind: 'hasMany';
    model: ModelRef<StoredRow>;
    foreignKey: string;
    dependent?: 'destroy';
} | {
    kind: 'hasOne';
    model: ModelRef<StoredRow>;
    foreignKey: string;
    comparator?: (left: StoredRow, right: StoredRow) => number;
} | {
    kind: 'references';
    model: ModelRef<StoredRow>;
    ids: (row: StoredRow) => ReadonlyArray<string | null | undefined> | string | null | undefined;
};
export type MembershipDelta = {
    scopeKey: string;
    append?: string[];
    detach?: string[];
};
/** Declare an inverse parent relation with optional derived parent updates (values from event data). */
export declare const belongsTo: <TChild, TParent>(model: ModelRef<TParent>, options: {
    foreignKey: keyof TChild & string;
    touch?: (child: TChild, parent: TParent) => Partial<TParent> | null;
    counterCache?: {
        field: keyof TParent & string;
        filter?: (child: TChild) => boolean;
    };
}) => RelationDecl;
/** Declare a direct child relation whose cascade authority is explicit destroy only. */
export declare const hasMany: <TParent, TChild>(model: ModelRef<TChild>, options: {
    foreignKey: keyof TChild & string;
    dependent?: "destroy";
}) => RelationDecl;
/** Declare a query-only single child relation. */
export declare const hasOne: <TParent, TChild>(model: ModelRef<TChild>, options: {
    foreignKey: keyof TChild & string;
    comparator?: (left: TChild, right: TChild) => number;
}) => RelationDecl;
/** Declare a GC-only reference edge: ids extracted from the row keep target-model rows alive. */
export declare const references: <TChild, TRef>(model: ModelRef<TRef>, options: {
    ids: (child: TChild) => ReadonlyArray<string | null | undefined> | string | null | undefined;
}) => RelationDecl;
/**
 * Model-side capabilities the plan expander needs. Registered once per defineModel; the registry
 * survives resetRuntime the same way apply targets do - models keep working after the kill-switch.
 * Membership hooks derive declarative scope membership from ScopeSpec.by so event rows join and
 * leave their scopes in the SAME plan (same-tick visibility for optimistic/ingest rows).
 */
export type RelationHost = {
    relations(): Record<string, RelationDecl>;
    has(id: string): boolean;
    read(id: string): StoredRow | undefined;
    normalize(input: unknown): StoredRow | null;
    membershipForUpsert(row: StoredRow): MembershipDelta[];
    membershipForPatch(id: string, patch: StoredRow): MembershipDelta[];
    detachForDestroy(id: string): MembershipDelta[];
};
export declare const registerRelationHost: (modelId: string, host: RelationHost) => (() => void);
/** True when the model declares a hasMany dependent:'destroy' cascade - optimistic destroy cannot roll such a cascade back. */
export declare const hasDependentCascade: (modelId: string) => boolean;
/**
 * Expand an EVENT plan with declared relation side effects (the Rails-callbacks analog):
 * counterCache increments for first-seen children, touch projections onto parents (emitted as
 * 'patch' ops in stored format, folded per parent so several children in one plan compose),
 * dependent destroy cascades, and declarative scope membership from ScopeSpec.by. Snapshot plans
 * (query pages / entity refreshes) must NOT be expanded - server snapshots already carry derived
 * state, so defineModel routes them through the verbatim apply path. A parent upserted by the same
 * plan is authoritative: its accumulated touch is cancelled and counter ops against it are
 * filtered out.
 */
export declare const expandPlan: (ops: JournalOp[]) => JournalOp[];
export {};
//# sourceMappingURL=relations.d.ts.map