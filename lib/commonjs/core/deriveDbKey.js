"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.deriveDbKey = void 0;
var _compileDbWhere = require("./compileDbWhere.js");
var _serialize = require("./serialize.js");
const deriveDbKeyFromSource = (model, scope) => {
  const collectionId = model.collection.id;
  const normalizedScope = (0, _compileDbWhere.normalizeDbCondition)(scope);
  if (!normalizedScope) {
    return ['db', collectionId];
  }
  return ['db', collectionId, (0, _serialize.stableSerialize)(normalizedScope)];
};

/**
 * Derive the React Query key used for a model-backed DB scope.
 *
 * @param model Collection model whose collection id anchors the key.
 * @param scope Optional stored-row filter scope; normalized and stable-serialized when present.
 * @returns A readonly query key suitable for invalidation and refetch APIs.
 */
const deriveDbKey = (model, scope) => deriveDbKeyFromSource(model, scope);
exports.deriveDbKey = deriveDbKey;
//# sourceMappingURL=deriveDbKey.js.map