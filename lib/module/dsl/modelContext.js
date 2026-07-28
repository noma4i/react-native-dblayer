"use strict";

import { createModelStore, registerModelStoreFactory } from "../core/store.js";
import { createScopeIndex } from "../core/planes/scopeIndex.js";
import { getDbRuntimeConfig, getOperationState, getStoragePrefix } from "./configure.js";
export const createModelContext = options => {
  let planesRef = null;
  let storeRef = null;
  let relationCache = null;
  let modelRef;
  let revision = 0;
  const issuedScopeSequences = new Map();
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = getDbRuntimeConfig();
    const store = createModelStore({
      modelId: options.modelId,
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: getStoragePrefix,
      applyWriteGate: options.applyWriteGate,
      ownedFields: (rowId, operationId) => getOperationState().ownedFields(options.modelId, rowId, operationId)
    });
    const scopeIndex = createScopeIndex({
      modelId: options.modelId,
      scopeNames: [...options.scopeNames],
      storage: runtime.storage,
      prefix: getStoragePrefix
    });
    store.hydrate();
    scopeIndex.hydrate();
    storeRef = store;
    planesRef = {
      entityState: store,
      scopeIndex
    };
    return planesRef;
  };
  registerModelStoreFactory(options.modelId, () => {
    planes();
    return storeRef;
  });
  return {
    planes,
    resolvedRelations: () => relationCache ??= options.relations(),
    revision: () => revision,
    bumpRevision: () => {
      revision += 1;
    },
    issuedScopeSequence: key => issuedScopeSequences.get(key),
    setIssuedScopeSequence: (key, value) => {
      issuedScopeSequences.set(key, value);
    },
    model: () => modelRef,
    setModel: model => {
      modelRef = model;
    },
    reset: () => {
      revision += 1;
      issuedScopeSequences.clear();
      planesRef?.scopeIndex.reset();
      storeRef?.reset();
      storeRef?.dispose();
      storeRef = null;
      planesRef = null;
    }
  };
};
//# sourceMappingURL=modelContext.js.map