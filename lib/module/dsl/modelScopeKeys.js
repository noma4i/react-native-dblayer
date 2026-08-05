"use strict";

import { buildScopeKey } from "../core/compileDbWhere.js";
import { compositeKey } from "../core/serialize.js";
import { readModelField } from "./modelNormalization.js";
import { isRecord } from "../utils/normalizeHelpers.js";
export const createModelScopeKeys = (config, scopeByFieldMap) => {
  const scopeValueFromRow = (by, row) => {
    const value = {};
    for (const [scopeField, rowField] of Object.entries(by)) {
      const fieldSpec = config.fields[rowField];
      // A derived by-value always comes from the FINAL committed row: the stored copy of a derived
      // field can be stale against a policy-restored source and must never drive attach/detach.
      const fieldValue = fieldSpec ? readModelField(fieldSpec, row, rowField, false) : row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const normalizeScopeValue = (scopeName, scopeValue) => {
    if (!isRecord(scopeValue)) return scopeValue;
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
    if (!isRecord(scopeValue)) return false;
    return Object.keys(by).every(field => scopeValue[field] !== undefined && scopeValue[field] !== null);
  };
  const isScopeValueComplete = (scopeName, scopeValue) => isNormalizedScopeValueComplete(scopeName, normalizeScopeValue(scopeName, scopeValue));
  const keyForScope = (scopeName, scopeValue) => {
    const normalized = normalizeScopeValue(scopeName, scopeValue);
    if (!isNormalizedScopeValueComplete(scopeName, normalized)) {
      const by = scopeByFieldMap.get(scopeName);
      const missing = Object.keys(by).find(field => !isRecord(normalized) || normalized[field] === undefined || normalized[field] === null);
      throw new Error(`${config.name}.${scopeName}: scope value must provide ${missing}`);
    }
    return compositeKey(scopeName, buildScopeKey(normalized));
  };
  return {
    keyForScope,
    normalizeScopeValue,
    isScopeValueComplete,
    scopeValueFromRow
  };
};
//# sourceMappingURL=modelScopeKeys.js.map