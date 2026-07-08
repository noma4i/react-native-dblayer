import type { CollectionModel } from '../types';
import { normalizeDbCondition } from './compileDbWhere';
import { stableSerialize } from './serialize';

type DbKeySource = {
  collection: { readonly id: string };
};

const deriveDbKeyFromSource = (model: DbKeySource, scope?: object): readonly unknown[] => {
  const collectionId = model.collection.id;
  const normalizedScope = normalizeDbCondition(scope);
  if (!normalizedScope) {
    return ['db', collectionId] as const;
  }
  return ['db', collectionId, stableSerialize(normalizedScope)] as const;
};

/**
 * Derive the React Query key used for a model-backed DB scope.
 *
 * @param model Collection model whose collection id anchors the key.
 * @param scope Optional stored-row filter scope; normalized and stable-serialized when present.
 * @returns A readonly query key suitable for invalidation and refetch APIs.
 */
export const deriveDbKey = (model: CollectionModel<any, any>, scope?: object): readonly unknown[] => deriveDbKeyFromSource(model, scope);
