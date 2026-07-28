/** Structural reference to a defined model; relation thunks resolve it after both models exist. */
export type ModelRef<TStored> = {
    modelId: string;
    find(id: string | null | undefined): TStored | undefined;
    all(): TStored[];
    where(where: Record<string, unknown>): TStored[];
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
export type AcceptedRow = {
    model: string;
    id: string;
    before: StoredRow | undefined;
    after: StoredRow;
    origin?: 'event' | 'replace';
};
export type DestroyedRow = {
    model: string;
    id: string;
    before: StoredRow;
    origin?: 'replace';
};
export {};
//# sourceMappingURL=core.relations.types.d.ts.map