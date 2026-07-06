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
export const deriveDbKey = (model, scope) => deriveDbKeyFromSource(model, scope);
//# sourceMappingURL=deriveDbKey.js.map