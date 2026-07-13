import type { SyncContract } from '../types';
/** Build a merge sync contract for server data writes. */
export declare const mergeSyncContract: <TScope = undefined>(source: string, scope?: TScope, protectAfterSeq?: number) => SyncContract<TScope>;
/** Build a replace sync contract for server data writes. */
export declare const replaceSyncContract: <TScope = undefined>(source: string, scope?: TScope, protectAfterSeq?: number) => SyncContract<TScope>;
//# sourceMappingURL=serverSync.d.ts.map