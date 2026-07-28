"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelContext = void 0;
var _store = require("../core/store.js");
var _scopeIndex = require("../core/planes/scopeIndex.js");
var _configure = require("./configure.js");
const createModelContext = options => {
  let planesRef = null;
  let storeRef = null;
  let relationCache = null;
  let modelRef;
  let revision = 0;
  const issuedScopeSequences = new Map();
  const planes = () => {
    if (planesRef) return planesRef;
    const runtime = (0, _configure.getDbRuntimeConfig)();
    const store = (0, _store.createModelStore)({
      modelId: options.modelId,
      now: () => Date.now(),
      storage: runtime.storage,
      prefix: _configure.getStoragePrefix,
      applyWriteGate: options.applyWriteGate,
      ownedFields: (rowId, operationId) => (0, _configure.getOperationState)().ownedFields(options.modelId, rowId, operationId)
    });
    const scopeIndex = (0, _scopeIndex.createScopeIndex)({
      modelId: options.modelId,
      scopeNames: [...options.scopeNames],
      storage: runtime.storage,
      prefix: _configure.getStoragePrefix
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
  (0, _store.registerModelStoreFactory)(options.modelId, () => {
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
exports.createModelContext = createModelContext;
//# sourceMappingURL=modelContext.js.map