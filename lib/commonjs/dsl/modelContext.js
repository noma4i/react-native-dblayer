"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelContext = void 0;
var _diagnostics = require("../core/diagnostics.js");
var _store = require("../core/store.js");
var _scopeIndex = require("../core/planes/scopeIndex.js");
var _configure = require("./configure.js");
const createModelContext = options => {
  let planesRef = null;
  let storeRef = null;
  let relationCache = null;
  let modelRef;
  const issuedScopeSequences = new Map();
  const rowEpochs = new Map();
  const existenceEpochs = new Map();
  const fieldEpochs = new Map();
  let pendingEpoch = null;
  let pendingRows = new Set();
  let pendingExistence = new Set();
  let pendingFields = new Map();
  const changedAfter = (epochs, id, baseRevision) => (epochs.get(id) ?? 0) > baseRevision;
  const revisions = {
    admitRow: (incoming, previous, baseRevision) => {
      if (baseRevision === undefined) return incoming;
      if (changedAfter(existenceEpochs, incoming.id, baseRevision)) {
        (0, _diagnostics.noteCausalAdmissionDrop)({
          model: options.modelId,
          id: incoming.id,
          kind: 'existence',
          fields: []
        });
        return null;
      }
      if (!previous) {
        if (!changedAfter(rowEpochs, incoming.id, baseRevision)) return incoming;
        (0, _diagnostics.noteCausalAdmissionDrop)({
          model: options.modelId,
          id: incoming.id,
          kind: 'row',
          fields: []
        });
        return null;
      }
      const epochs = fieldEpochs.get(incoming.id);
      if (!epochs) return incoming;
      const admitted = {
        ...incoming
      };
      const evictedFields = [];
      for (const field of Object.keys(incoming)) {
        if (field === 'id' || (epochs.get(field) ?? 0) <= baseRevision) continue;
        evictedFields.push(field);
        if (Object.hasOwn(previous, field)) admitted[field] = previous[field];else delete admitted[field];
      }
      if (evictedFields.length > 0) (0, _diagnostics.noteCausalAdmissionDrop)({
        model: options.modelId,
        id: incoming.id,
        kind: 'fields',
        fields: evictedFields
      });
      return admitted;
    },
    admitPatch: (id, patch, remove, previous, baseRevision) => {
      if (!previous) return null;
      if (baseRevision === undefined) return {
        patch,
        remove: [...remove]
      };
      if (changedAfter(existenceEpochs, id, baseRevision)) {
        (0, _diagnostics.noteCausalAdmissionDrop)({
          model: options.modelId,
          id,
          kind: 'existence',
          fields: []
        });
        return null;
      }
      const epochs = fieldEpochs.get(id);
      if (!epochs) return {
        patch,
        remove: [...remove]
      };
      const evicted = field => (epochs.get(field) ?? 0) > baseRevision;
      const admittedPatch = Object.fromEntries(Object.entries(patch).filter(([field]) => !evicted(field)));
      const admittedRemove = remove.filter(field => !evicted(field));
      const evictedFields = [...Object.keys(patch), ...remove].filter(evicted);
      if (evictedFields.length > 0) (0, _diagnostics.noteCausalAdmissionDrop)({
        model: options.modelId,
        id,
        kind: 'fields',
        fields: evictedFields
      });
      return Object.keys(admittedPatch).length > 0 || admittedRemove.length > 0 ? {
        patch: admittedPatch,
        remove: admittedRemove
      } : null;
    },
    admitDestroy: (id, baseRevision) => baseRevision === undefined || !changedAfter(rowEpochs, id, baseRevision) && !changedAfter(existenceEpochs, id, baseRevision),
    beginApply: epoch => {
      if (pendingEpoch !== null) throw new Error(`${options.modelId}: revision apply already active`);
      pendingEpoch = epoch;
      pendingRows = new Set();
      pendingExistence = new Set();
      pendingFields = new Map();
    },
    notePut: (id, fields, inserted) => {
      if (pendingEpoch === null) throw new Error(`${options.modelId}: revision apply is not active`);
      pendingRows.add(id);
      if (inserted) pendingExistence.add(id);
      const current = pendingFields.get(id) ?? new Set();
      for (const field of fields) if (field !== 'id') current.add(field);
      pendingFields.set(id, current);
    },
    noteDestroy: id => {
      if (pendingEpoch === null) throw new Error(`${options.modelId}: revision apply is not active`);
      pendingRows.add(id);
      pendingExistence.add(id);
    },
    commitApply: () => {
      if (pendingEpoch === null) throw new Error(`${options.modelId}: revision apply is not active`);
      for (const id of pendingRows) rowEpochs.set(id, pendingEpoch);
      for (const id of pendingExistence) existenceEpochs.set(id, pendingEpoch);
      for (const [id, fields] of pendingFields) {
        const current = fieldEpochs.get(id) ?? new Map();
        for (const field of fields) current.set(field, pendingEpoch);
        fieldEpochs.set(id, current);
      }
      pendingEpoch = null;
      pendingRows.clear();
      pendingExistence.clear();
      pendingFields.clear();
    },
    abortApply: () => {
      pendingEpoch = null;
      pendingRows.clear();
      pendingExistence.clear();
      pendingFields.clear();
    },
    reset: () => {
      rowEpochs.clear();
      existenceEpochs.clear();
      fieldEpochs.clear();
      pendingEpoch = null;
      pendingRows.clear();
      pendingExistence.clear();
      pendingFields.clear();
    }
  };
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
    revisions,
    issuedScopeSequence: key => issuedScopeSequences.get(key),
    setIssuedScopeSequence: (key, value) => {
      issuedScopeSequences.set(key, value);
    },
    model: () => modelRef,
    setModel: model => {
      modelRef = model;
    },
    reset: () => {
      revisions.reset();
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