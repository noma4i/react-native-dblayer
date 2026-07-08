"use strict";

import { normalizeDbCondition } from "./compileDbWhere.js";
import { stableSerialize } from "./serialize.js";
const deriveDbKeyFromSource = (model, scope) => {
  const collectionId = model.collection.id;
  const normalizedScope = normalizeDbCondition(scope);
  if (!normalizedScope) {
    return ['db', collectionId];
  }
  return ['db', collectionId, stableSerialize(normalizedScope)];
};

/**
 * Derive the React Query key used for a model-backed DB scope.
 *
 * @param model Collection model whose collection id anchors the key.
 * @param scope Optional stored-row filter scope; normalized and stable-serialized when present.
 * @returns A readonly query key suitable for invalidation and refetch APIs.
 */
export const deriveDbKey = (model, scope) => deriveDbKeyFromSource(model, scope);
//# sourceMappingURL=deriveDbKey.js.map