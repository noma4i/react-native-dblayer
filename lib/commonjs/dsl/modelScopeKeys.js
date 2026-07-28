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
  const coerceScopeValueForKey = (scopeName, scopeValue) => {
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
  const keyForScope = (scopeName, scopeValue) => {
    const by = scopeByFieldMap.get(scopeName);
    if (by && scopeValue !== null) {
      for (const field of Object.keys(by)) {
        if (!(0, _normalizeHelpers.isRecord)(scopeValue) || scopeValue[field] === undefined) throw new Error(`${config.name}.${scopeName}: scope value must provide ${field}`);
      }
    }
    return (0, _serialize.compositeKey)(scopeName, (0, _compileDbWhere.buildScopeKey)(coerceScopeValueForKey(scopeName, scopeValue)));
  };
  return {
    keyForScope,
    scopeValueFromRow
  };
};
exports.createModelScopeKeys = createModelScopeKeys;
//# sourceMappingURL=modelScopeKeys.js.map