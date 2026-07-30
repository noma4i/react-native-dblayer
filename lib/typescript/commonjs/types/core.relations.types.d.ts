/** Structural reference to a defined model; relation thunks resolve it after both models exist. */
export type ModelRef<TStored> = {
    modelId: string;
    find(id: string | null | undefined): TStored | undefined;
    all(): TStored[];
    where(where: Record<string, unknown>): TStored[];
};
export type FacadeRelationTarget<TStored> = {
    key: string;
    find(id: string | null | undefined): TStored | undefined;
    where(where: Record<string, unknown>): {
        read(): TStored[];
    };
};
export type RelationTarget<TStored> = ModelRef<TStored> | FacadeRelationTarget<TStored>;
/** Untyped stored row: arbitrary model fields without an id requirement. */
export type StoredRow = Record<string, unknown>;
/** Parent-touch producer: derives a parent patch from a child write, or null to skip. */
export type TouchFn = (child: StoredRow, parent: StoredRow) => StoredRow | null;
export type BelongsToDecl<TStored = StoredRow> = {
    kind: 'belongsTo';
    model: ModelRef<TStored>;
    foreignKey: string;
    touch?: TouchFn;
    counterCache?: {
        field: string;
        filter?: (child: StoredRow) => boolean;
    };
};
export type HasManyDecl<TStored = StoredRow> = {
    kind: 'hasMany';
    model: ModelRef<TStored>;
    foreignKey: string;
    dependent?: 'destroy';
};
export type HasOneDecl<TStored = StoredRow> = {
    kind: 'hasOne';
    model: ModelRef<TStored>;
    foreignKey: string;
    comparator?: (left: StoredRow, right: StoredRow) => number;
};
export type ReferencesDecl<TStored = StoredRow> = {
    kind: 'references';
    model: ModelRef<TStored>;
    ids: (row: StoredRow) => ReadonlyArray<string | null | undefined> | string | null | undefined;
};
export type RelationDecl<TStored = StoredRow> = BelongsToDecl<TStored> | HasManyDecl<TStored> | HasOneDecl<TStored> | ReferencesDecl<TStored>;
export type MembershipDelta = {
    scopeKey: string;
    append?: string[];
    detach?: string[];
};
export type AcceptedRow = {
    model: string;
    id: string;
    before: StoredRow | undefined;
    after: StoredRow;
    origin?: 'event' | 'replace';
    changedFields: string[] | null;
};
export type DestroyedRow = {
    model: string;
    id: string;
    before: StoredRow;
    origin?: 'replace';
};
/** Model surface relation effects read and plan against. */
export type RelationHost = {
    relations(): Record<string, RelationDecl>;
    read(id: string): StoredRow | undefined;
    membershipForUpsert(before: StoredRow | undefined, after: StoredRow): MembershipDelta[];
    detachForDestroy(id: string): MembershipDelta[];
};
/** One planned parent-touch application with its pre-touch view for inverse plans. */
export type TouchEntry = {
    model: string;
    id: string;
    view: StoredRow;
    patch: StoredRow;
};
/** Address of one counter-cache field on a parent row. */
export type CounterRef = {
    model: string;
    id: string;
    field: string;
};
/** Snapshot reader used by relation planning to include earlier operations in the same envelope. */
export type RelationPlanReader = {
    read(model: string, id: string): StoredRow | undefined;
    rows(model: string): StoredRow[];
};
//# sourceMappingURL=core.relations.types.d.ts.map