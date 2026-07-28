import { buildScopeKey } from '../core/compileDbWhere';
import { compositeKey } from '../core/serialize';
import type { ModelFieldSpecs, ModelScopeKeys } from '../types';
import { readModelField } from './modelNormalization';
import { isRecord } from '../utils/normalizeHelpers';

export const createModelScopeKeys = (
  config: { name: string; fields: ModelFieldSpecs },
  scopeByFieldMap: ReadonlyMap<string, Record<string, string>>
): ModelScopeKeys => {
  const scopeValueFromRow = (by: Record<string, string>, row: Record<string, unknown>): Record<string, unknown> | null => {
    const value: Record<string, unknown> = {};
    for (const [scopeField, rowField] of Object.entries(by)) {
      const fieldSpec = config.fields[rowField];
      const fieldValue = fieldSpec?.derived === true && row[rowField] !== undefined ? row[rowField] : fieldSpec ? readModelField(fieldSpec, row, rowField, false) : row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const coerceScopeValueForKey = (scopeName: string, scopeValue: unknown): unknown => {
    if (!isRecord(scopeValue)) return scopeValue;
    const by = scopeByFieldMap.get(scopeName);
    if (!by) return scopeValue;
    const out: Record<string, unknown> = {};
    for (const [scopeField, raw] of Object.entries(scopeValue)) {
      const rowField = by[scopeField];
      const fieldSpec = rowField ? config.fields[rowField] : undefined;
      out[scopeField] = fieldSpec && !fieldSpec.derived && raw !== undefined && raw !== null ? fieldSpec.readValue(raw) : raw;
    }
    return out;
  };
  const keyForScope = (scopeName: string, scopeValue: unknown): string => {
    const by = scopeByFieldMap.get(scopeName);
    if (by && scopeValue !== null) {
      for (const field of Object.keys(by)) {
        if (!isRecord(scopeValue) || scopeValue[field] === undefined) throw new Error(`${config.name}.${scopeName}: scope value must provide ${field}`);
      }
    }
    return compositeKey(scopeName, buildScopeKey(coerceScopeValueForKey(scopeName, scopeValue)));
  };
  return { keyForScope, scopeValueFromRow };
};
