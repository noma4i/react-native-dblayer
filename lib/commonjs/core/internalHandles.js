"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerInternalScopeHandle = exports.registerInternalModelHandle = exports.hasInternalScopeHandle = exports.getInternalScopeHandle = exports.getInternalModelHandle = void 0;
const modelHandles = new WeakMap();
const scopeHandles = new WeakMap();
const registerInternalModelHandle = (model, handle) => {
  modelHandles.set(model, handle);
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
const getInternalScopeHandle = scope => {
  const handle = scopeHandles.get(scope);
  if (!handle) throw new Error('Unknown scope handle');
  return handle;
};
exports.getInternalScopeHandle = getInternalScopeHandle;
const hasInternalScopeHandle = scope => scopeHandles.has(scope);
exports.hasInternalScopeHandle = hasInternalScopeHandle;
//# sourceMappingURL=internalHandles.js.map