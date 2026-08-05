import type { PersistenceManifest, SchemaDeclaration, SchemaFingerprints } from '../types';
export declare const DB_FORMAT_VERSION = 10;
/** Register one model declaration for the persistence schema fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export declare const registerSchemaDeclaration: (declaration: SchemaDeclaration) => void;
export declare const computeSchemaFingerprints: () => SchemaFingerprints;
export declare const writePersistenceManifest: (prefix: string, manifest: PersistenceManifest) => void;
/** Reconcile persisted state with the current format and schema before the boot fsck, then persist the current manifest. An unreadable or mismatched manifest wipes the cache; the outbox and quarantine ride through. */
export declare const reconcilePersistence: () => {
    reset: boolean;
};
//# sourceMappingURL=schemaManifest.d.ts.map