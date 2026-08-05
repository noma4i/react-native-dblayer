import type { InternalModelHandle, InternalScopeHandle } from '../types';

const modelHandles = new WeakMap<object, InternalModelHandle>();
const modelHandlesById = new Map<string, InternalModelHandle>();
const scopeHandles = new WeakMap<object, InternalScopeHandle>();

export const registerInternalModelHandle = (model: object, handle: InternalModelHandle): void => {
  modelHandles.set(model, handle);
  modelHandlesById.set(handle.modelId, handle);
};

export const registerInternalScopeHandle = (scope: object, handle: InternalScopeHandle): void => {
  scopeHandles.set(scope, handle);
};

export const getInternalModelHandle = (model: object): InternalModelHandle => {
  const handle = modelHandles.get(model);
  if (!handle) throw new Error('Unknown model handle');
  return handle;
};

export const getInternalModelHandleById = (modelId: string): InternalModelHandle => {
  const handle = modelHandlesById.get(modelId);
  if (!handle) throw new Error(`Unknown model handle for ${modelId}`);
  return handle;
};

export const getInternalScopeHandle = (scope: object): InternalScopeHandle => {
  const handle = scopeHandles.get(scope);
  if (!handle) throw new Error('Unknown scope handle');
  return handle;
};

export const hasInternalScopeHandle = (scope: object): boolean => scopeHandles.has(scope);
