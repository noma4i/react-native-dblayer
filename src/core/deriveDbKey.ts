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

export const deriveDbKey = (model: CollectionModel<any, any>, scope?: object): readonly unknown[] => deriveDbKeyFromSource(model, scope);
