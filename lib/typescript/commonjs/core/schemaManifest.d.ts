export declare const DB_FORMAT_VERSION = 2;
type FieldDeclaration = {
    kind: string;
    mode: string;
    hasDefault: boolean;
};
type ScopeDeclaration = {
    by: Record<string, string> | null;
    sort: string;
};
export type SchemaDeclaration = {
    id: string;
    name: string;
    fields: Record<string, FieldDeclaration>;
    scopes: Record<string, ScopeDeclaration>;
};
type PersistenceManifest = {
    formatVersion: number;
    schemaFingerprint: string;
    dataVersion: string | null;
};
/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export declare const registerSchemaDeclaration: (declaration: SchemaDeclaration) => void;
export declare const computeSchemaFingerprint: () => string;
export declare const readPersistenceManifest: (prefix: string) => PersistenceManifest | undefined;
export declare const writePersistenceManifest: (prefix: string, manifest: PersistenceManifest) => void;
/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
export declare const ensurePersistenceCompatibility: () => {
    reset: boolean;
};
export {};
//# sourceMappingURL=schemaManifest.d.ts.map