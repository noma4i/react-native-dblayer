"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelScopeKeys = void 0;
var _compileDbWhere = require("../core/compileDbWhere.js");
var _serialize = require("../core/serialize.js");
var _modelNormalization = require("./modelNormalization.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const createModelScopeKeys = (config, scopeByFieldMap) => {
  const scopeValueFromRow = (by, row) => {
    const value = {};
    for (const [scopeField, rowField] of Object.entries(by)) {
      const fieldSpec = config.fields[rowField];
      const fieldValue = fieldSpec?.derived === true && row[rowField] !== undefined ? row[rowField] : fieldSpec ? (0, _modelNormalization.readModelField)(fieldSpec, row, rowField, false) : row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const normalizeScopeValue = (scopeName, scopeValue) => {
    if (!(0, _normalizeHelpers.isRecord)(scopeValue)) return scopeValue;
    const by = scopeByFieldMap.get(scopeName);
    if (!by) return scopeValue;
    const out = {};
    for (const [scopeField, raw] of Object.entries(scopeValue)) {
      const rowField = by[scopeField];
      const fieldSpec = rowField ? config.fields[rowField] : undefined;
      out[scopeField] = fieldSpec && !fieldSpec.derived && raw !== undefined && raw !== null ? fieldSpec.readValue(raw) : raw;
    }
    return out;
  };
  const isNormalizedScopeValueComplete = (scopeName, scopeValue) => {
    const by = scopeByFieldMap.get(scopeName);
    if (!by || scopeValue === null) return true;
    if (!(0, _normalizeHelpers.isRecord)(scopeValue)) return false;
    return Object.keys(by).every(field => scopeValue[field] !== undefined && scopeValue[field] !== null);
  };
  const isScopeValueComplete = (scopeName, scopeValue) => isNormalizedScopeValueComplete(scopeName, normalizeScopeValue(scopeName, scopeValue));
  const keyForScope = (scopeName, scopeValue) => {
    const normalized = normalizeScopeValue(scopeName, scopeValue);
    if (!isNormalizedScopeValueComplete(scopeName, normalized)) {
      const by = scopeByFieldMap.get(scopeName);
      const missing = Object.keys(by).find(field => !(0, _normalizeHelpers.isRecord)(normalized) || normalized[field] === undefined || normalized[field] === null);
      throw new Error(`${config.name}.${scopeName}: scope value must provide ${missing}`);
    }
    return (0, _serialize.compositeKey)(scopeName, (0, _compileDbWhere.buildScopeKey)(normalized));
  };
  return {
    keyForScope,
    normalizeScopeValue,
    isScopeValueComplete,
    scopeValueFromRow
  };
};
exports.createModelScopeKeys = createModelScopeKeys;
//# sourceMappingURL=modelScopeKeys.js.map