"use strict";

const modelHandles = new WeakMap();
const scopeHandles = new WeakMap();
export const registerInternalModelHandle = (model, handle) => {
  modelHandles.set(model, handle);
};
export const registerInternalScopeHandle = (scope, handle) => {
  scopeHandles.set(scope, handle);
};
export const getInternalModelHandle = model => {
  const handle = modelHandles.get(model);
  if (!handle) throw new Error('Unknown model handle');
  return handle;
};
export const getInternalScopeHandle = scope => {
  const handle = scopeHandles.get(scope);
  if (!handle) throw new Error('Unknown scope handle');
  return handle;
};
export const hasInternalScopeHandle = scope => scopeHandles.has(scope);
//# sourceMappingURL=internalHandles.js.map