import type { CollectionModel } from '../types';
/**
 * Derive the React Query key used for a model-backed DB scope.
 *
 * @param model Collection model whose collection id anchors the key.
 * @param scope Optional stored-row filter scope; normalized and stable-serialized when present.
 * @returns A readonly query key suitable for invalidation and refetch APIs.
 */
export declare const deriveDbKey: (model: CollectionModel<any, any>, scope?: object) => readonly unknown[];
//# sourceMappingURL=deriveDbKey.d.ts.map