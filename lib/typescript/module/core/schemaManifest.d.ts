export declare const DB_FORMAT_VERSION = 6;
import type { PersistenceManifest, SchemaDeclaration } from '../types';
/** Register one model declaration for the persistence compatibility fingerprint. Nested array and object shape recursion is intentionally not fingerprinted. */
export declare const registerSchemaDeclaration: (declaration: SchemaDeclaration) => void;
export declare const computeSchemaFingerprint: () => string;
export declare const writePersistenceManifest: (prefix: string, manifest: PersistenceManifest) => void;
/** Reset incompatible persisted state before journal replay, then persist the current manifest. */
export declare const ensurePersistenceCompatibility: () => {
    reset: boolean;
};
//# sourceMappingURL=schemaManifest.d.ts.map