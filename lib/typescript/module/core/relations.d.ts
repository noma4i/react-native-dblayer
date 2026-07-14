export type ModelRef<TStored> = {
    get(id: string | null | undefined): TStored | undefined;
};
export type RelationDecl = {
    kind: 'belongsTo';
    model: ModelRef<unknown>;
    foreignKey: string;
    touch?: (child: unknown, parent: unknown) => Record<string, unknown> | null;
    counterCache?: {
        field: string;
        filter?: (child: unknown) => boolean;
    };
} | {
    kind: 'hasMany';
    model: ModelRef<unknown>;
    foreignKey: string;
    dependent?: 'destroy';
} | {
    kind: 'hasOne';
    model: ModelRef<unknown>;
    foreignKey: string;
    comparator?: (left: unknown, right: unknown) => number;
};
/** Declare an inverse parent relation and optional derived parent updates. */
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
//# sourceMappingURL=relations.d.ts.map