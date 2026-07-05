import type { PersistentMutationTransaction } from '../types';
/** Register a model runtime-state reset callback. */
export declare const registerModelRuntimeReset: (name: string, resetFn: () => void) => void;
/** Reset all registered model runtime state. */
export declare const resetAllModelsState: () => void;
/** Run a callback inside the ambient managed mutation batch. */
export declare const runInManagedMutationBatch: <T>(fn: () => T) => T;
/** Return true when code is running inside a managed mutation batch. */
export declare const isInManagedMutationBatch: () => boolean;
/** Registry for clearing every persistent collection. */
export declare const clearAllCollections: {
    register: (cleanupFn: () => void) => void;
    run: () => void;
};
/** Register a collection transaction acceptor for managed mutation commits. */
export declare const registerPersistentCollectionMutationAcceptor: (collectionId: string, acceptMutations: (transaction: PersistentMutationTransaction) => void) => void;
/** Forward a persisted mutation transaction to every registered collection. */
export declare const acceptPersistentCollectionMutations: (transaction: PersistentMutationTransaction) => void;
/** Full cleanup: collections, freshness metadata, and runtime state. */
export declare const devClearAllDataAndState: () => void;
//# sourceMappingURL=registry.d.ts.map