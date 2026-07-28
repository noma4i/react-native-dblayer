/** One field entry inside a persisted schema declaration fingerprint. */
export type FieldDeclaration = {
    kind: string;
    mode: string;
    hasDefault: boolean;
};
/** One scope entry inside a persisted schema declaration fingerprint. */
export type ScopeDeclaration = {
    by: Record<string, string> | null;
    sort: string;
};
export type SchemaDeclaration = {
    id: string;
    name: string;
    fields: Record<string, FieldDeclaration>;
    scopes: Record<string, ScopeDeclaration>;
};
//# sourceMappingURL=core.schemaManifest.types.d.ts.map