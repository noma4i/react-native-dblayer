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
/** Persisted schema manifest used by the boot compatibility gate. */
export type SchemaFingerprints = Readonly<Record<string, string>>;
export type PersistenceManifest = {
    formatVersion: number;
    schemaFingerprints: SchemaFingerprints;
    dataVersion: string | null;
};
export type SingleFingerprintPersistenceManifest = {
    formatVersion: number;
    schemaFingerprint: string;
    dataVersion: string | null;
};
export type PersistenceManifestRecord = PersistenceManifest | SingleFingerprintPersistenceManifest;
//# sourceMappingURL=core.schemaManifest.types.d.ts.map