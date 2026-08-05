"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerInternalScopeHandle = exports.registerInternalModelHandle = exports.hasInternalScopeHandle = exports.getInternalScopeHandle = exports.getInternalModelHandleById = exports.getInternalModelHandle = void 0;
const modelHandles = new WeakMap();
const modelHandlesById = new Map();
const scopeHandles = new WeakMap();
const registerInternalModelHandle = (model, handle) => {
  modelHandles.set(model, handle);
  modelHandlesById.set(handle.modelId, handle);
};
exports.registerInternalModelHandle = registerInternalModelHandle;
const registerInternalScopeHandle = (scope, handle) => {
  scopeHandles.set(scope, handle);
};
exports.registerInternalScopeHandle = registerInternalScopeHandle;
const getInternalModelHandle = model => {
  const handle = modelHandles.get(model);
  if (!handle) throw new Error('Unknown model handle');
  return handle;
};
exports.getInternalModelHandle = getInternalModelHandle;
const getInternalModelHandleById = modelId => {
  const handle = modelHandlesById.get(modelId);
  if (!handle) throw new Error(`Unknown model handle for ${modelId}`);
  return handle;
};
exports.getInternalModelHandleById = getInternalModelHandleById;
const getInternalScopeHandle = scope => {
  const handle = scopeHandles.get(scope);
  if (!handle) throw new Error('Unknown scope handle');
  return handle;
};
exports.getInternalScopeHandle = getInternalScopeHandle;
const hasInternalScopeHandle = scope => scopeHandles.has(scope);
exports.hasInternalScopeHandle = hasInternalScopeHandle;
//# sourceMappingURL=internalHandles.js.map