import {
  registerInternalModelHandle,
  registerInternalScopeHandle,
  getInternalModelHandle,
  getInternalScopeHandle,
  hasInternalScopeHandle
} from '../../../core/internalHandles';

describe('internal handle registry guards', () => {
  it('throws "Unknown model handle" for an object that was never registered', () => {
    const strangerModel = {};
    expect(() => getInternalModelHandle(strangerModel)).toThrow('Unknown model handle');
  });

  it('returns the registered handle for a model that was registered', () => {
    const model = {};
    const handle = { tag: 'model-handle' } as never;
    registerInternalModelHandle(model, handle);
    expect(getInternalModelHandle(model)).toBe(handle);
  });

  it('throws "Unknown scope handle" for an object that was never registered', () => {
    const strangerScope = {};
    expect(() => getInternalScopeHandle(strangerScope)).toThrow('Unknown scope handle');
  });

  it('returns the registered handle for a scope that was registered, and hasInternalScopeHandle reflects it', () => {
    const scope = {};
    expect(hasInternalScopeHandle(scope)).toBe(false);

    const handle = { tag: 'scope-handle' } as never;
    registerInternalScopeHandle(scope, handle);

    expect(hasInternalScopeHandle(scope)).toBe(true);
    expect(getInternalScopeHandle(scope)).toBe(handle);
  });
});
