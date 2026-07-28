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
      const fieldValue = fieldSpec?.derived === true && row[rowField] !== undefined ? row[rowField] : fieldSpec ? readModelField(fieldSpec, row, rowField, false) : row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const coerceScopeValueForKey = (scopeName, scopeValue) => {
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
  const keyForScope = (scopeName, scopeValue) => {
    const by = scopeByFieldMap.get(scopeName);
    if (by && scopeValue !== null) {
      for (const field of Object.keys(by)) {
        if (!isRecord(scopeValue) || scopeValue[field] === undefined) throw new Error(`${config.name}.${scopeName}: scope value must provide ${field}`);
      }
    }
    return compositeKey(scopeName, buildScopeKey(coerceScopeValueForKey(scopeName, scopeValue)));
  };
  return {
    keyForScope,
    scopeValueFromRow
  };
};
//# sourceMappingURL=modelScopeKeys.js.map