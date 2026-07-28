import type { InternalModelHandle, InternalScopeHandle } from '../types';
export declare const registerInternalModelHandle: (model: object, handle: InternalModelHandle) => void;
export declare const registerInternalScopeHandle: (scope: object, handle: InternalScopeHandle) => void;
export declare const getInternalModelHandle: (model: object) => InternalModelHandle;
export declare const getInternalScopeHandle: (scope: object) => InternalScopeHandle;
export declare const hasInternalScopeHandle: (scope: object) => boolean;
//# sourceMappingURL=internalHandles.d.ts.map