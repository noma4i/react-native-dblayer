import type { PersistentMutationTransaction } from '../types';
import { clearAllFreshnessMetadata } from './freshnessStorage';

const resetFunctions = new Map<string, () => void>();
const collectionCleanupFunctions: Array<() => void> = [];
const collectionMutationAcceptors = new Map<string, (transaction: PersistentMutationTransaction) => void>();
let managedMutationBatchDepth = 0;

/** Register a model runtime-state reset callback. */
export const registerModelRuntimeReset = (name: string, resetFn: () => void): void => {
  resetFunctions.set(name, resetFn);
};

/** Reset all registered model runtime state. */
export const resetAllModelsState = (): void => {
  for (const resetFn of resetFunctions.values()) {
    resetFn();
  }
};

/** Run a callback inside the ambient managed mutation batch. */
export const runInManagedMutationBatch = <T>(fn: () => T): T => {
  managedMutationBatchDepth += 1;
  try {
    return fn();
  } finally {
    managedMutationBatchDepth = Math.max(0, managedMutationBatchDepth - 1);
  }
};

/** Return true when code is running inside a managed mutation batch. */
export const isInManagedMutationBatch = (): boolean => managedMutationBatchDepth > 0;

/** Registry for clearing every persistent collection. */
export const clearAllCollections = {
  register: (cleanupFn: () => void): void => {
    collectionCleanupFunctions.push(cleanupFn);
  },
  run: (): void => {
    for (const cleanupFn of collectionCleanupFunctions) {
      cleanupFn();
    }
    clearAllFreshnessMetadata();
  }
};

/** Register a collection transaction acceptor for managed mutation commits. */
export const registerPersistentCollectionMutationAcceptor = (collectionId: string, acceptMutations: (transaction: PersistentMutationTransaction) => void): void => {
  collectionMutationAcceptors.set(collectionId, acceptMutations);
};

/** Forward a persisted mutation transaction to every registered collection. */
export const acceptPersistentCollectionMutations = (transaction: PersistentMutationTransaction): void => {
  for (const acceptMutations of collectionMutationAcceptors.values()) {
    acceptMutations(transaction);
  }
};

/** Full cleanup: collections, freshness metadata, and runtime state. */
export const devClearAllDataAndState = (): void => {
  clearAllCollections.run();
  resetAllModelsState();
};
