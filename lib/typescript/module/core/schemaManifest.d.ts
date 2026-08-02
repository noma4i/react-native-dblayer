import type { PersistenceManifestRecord, SchemaDeclaration, SchemaFingerprints } from '../types';
export declare const DB_FORMAT_VERSION = 8;
/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export declare const registerSchemaDeclaration: (declaration: SchemaDeclaration) => void;
export declare const computeSchemaFingerprints: () => SchemaFingerprints;
export declare const writePersistenceManifest: (prefix: string, manifest: PersistenceManifestRecord) => void;
/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
export declare const ensurePersistenceCompatibility: () => {
    reset: boolean;
};
//# sourceMappingURL=schemaManifest.d.ts.map