"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runInManagedMutationBatch = exports.resetAllModelsState = exports.registerPersistentCollectionMutationAcceptor = exports.registerModelRuntimeReset = exports.isInManagedMutationBatch = exports.devClearAllDataAndState = exports.clearAllCollections = exports.acceptPersistentCollectionMutations = void 0;
var _freshnessStorage = require("./freshnessStorage.js");
const resetFunctions = new Map();
const collectionCleanupFunctions = [];
const collectionMutationAcceptors = new Map();
let managedMutationBatchDepth = 0;

/** Register a model runtime-state reset callback. */
const registerModelRuntimeReset = (name, resetFn) => {
  resetFunctions.set(name, resetFn);
};

/** Reset all registered model runtime state. */
exports.registerModelRuntimeReset = registerModelRuntimeReset;
const resetAllModelsState = () => {
  for (const resetFn of resetFunctions.values()) {
    resetFn();
  }
};

/** Run a callback inside the ambient managed mutation batch. */
exports.resetAllModelsState = resetAllModelsState;
const runInManagedMutationBatch = fn => {
  managedMutationBatchDepth += 1;
  try {
    return fn();
  } finally {
    managedMutationBatchDepth = Math.max(0, managedMutationBatchDepth - 1);
  }
};

/** Return true when code is running inside a managed mutation batch. */
exports.runInManagedMutationBatch = runInManagedMutationBatch;
const isInManagedMutationBatch = () => managedMutationBatchDepth > 0;

/** Registry for clearing every persistent collection. */
exports.isInManagedMutationBatch = isInManagedMutationBatch;
const clearAllCollections = exports.clearAllCollections = {
  register: cleanupFn => {
    collectionCleanupFunctions.push(cleanupFn);
  },
  run: () => {
    for (const cleanupFn of collectionCleanupFunctions) {
      cleanupFn();
    }
    (0, _freshnessStorage.clearAllFreshnessMetadata)();
  }
};

/** Register a collection transaction acceptor for managed mutation commits. */
const registerPersistentCollectionMutationAcceptor = (collectionId, acceptMutations) => {
  collectionMutationAcceptors.set(collectionId, acceptMutations);
};

/** Forward a persisted mutation transaction to every registered collection. */
exports.registerPersistentCollectionMutationAcceptor = registerPersistentCollectionMutationAcceptor;
const acceptPersistentCollectionMutations = transaction => {
  for (const acceptMutations of collectionMutationAcceptors.values()) {
    acceptMutations(transaction);
  }
};

/** Full cleanup: collections, freshness metadata, and runtime state. */
exports.acceptPersistentCollectionMutations = acceptPersistentCollectionMutations;
const devClearAllDataAndState = () => {
  clearAllCollections.run();
  resetAllModelsState();
};
exports.devClearAllDataAndState = devClearAllDataAndState;
//# sourceMappingURL=registry.js.map