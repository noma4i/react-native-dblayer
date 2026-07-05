import type { ServerSyncContract } from '../types';
/** Build a merge sync contract for server data writes. */
export declare const mergeSyncContract: <TScope = undefined>(source: string, scope?: TScope) => ServerSyncContract<TScope>;
/** Build a replace sync contract for server data writes. */
export declare const replaceSyncContract: <TScope = undefined>(source: string, scope?: TScope) => ServerSyncContract<TScope>;
//# sourceMappingURL=serverSync.d.ts.map