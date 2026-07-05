"use strict";

import { clearAllFreshnessMetadata } from "./freshnessStorage.js";
const resetFunctions = new Map();
const collectionCleanupFunctions = [];
const collectionMutationAcceptors = new Map();
let managedMutationBatchDepth = 0;

/** Register a model runtime-state reset callback. */
export const registerModelRuntimeReset = (name, resetFn) => {
  resetFunctions.set(name, resetFn);
};

/** Reset all registered model runtime state. */
export const resetAllModelsState = () => {
  for (const resetFn of resetFunctions.values()) {
    resetFn();
  }
};

/** Run a callback inside the ambient managed mutation batch. */
export const runInManagedMutationBatch = fn => {
  managedMutationBatchDepth += 1;
  try {
    return fn();
  } finally {
    managedMutationBatchDepth = Math.max(0, managedMutationBatchDepth - 1);
  }
};

/** Return true when code is running inside a managed mutation batch. */
export const isInManagedMutationBatch = () => managedMutationBatchDepth > 0;

/** Registry for clearing every persistent collection. */
export const clearAllCollections = {
  register: cleanupFn => {
    collectionCleanupFunctions.push(cleanupFn);
  },
  run: () => {
    for (const cleanupFn of collectionCleanupFunctions) {
      cleanupFn();
    }
    clearAllFreshnessMetadata();
  }
};

/** Register a collection transaction acceptor for managed mutation commits. */
export const registerPersistentCollectionMutationAcceptor = (collectionId, acceptMutations) => {
  collectionMutationAcceptors.set(collectionId, acceptMutations);
};

/** Forward a persisted mutation transaction to every registered collection. */
export const acceptPersistentCollectionMutations = transaction => {
  for (const acceptMutations of collectionMutationAcceptors.values()) {
    acceptMutations(transaction);
  }
};

/** Full cleanup: collections, freshness metadata, and runtime state. */
export const devClearAllDataAndState = () => {
  clearAllCollections.run();
  resetAllModelsState();
};
//# sourceMappingURL=registry.js.map