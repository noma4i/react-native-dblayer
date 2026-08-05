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
      // A derived by-value always comes from the FINAL committed row: the stored copy of a derived
      // field can be stale against a policy-restored source and must never drive attach/detach.
      const fieldValue = fieldSpec ? readModelField(fieldSpec, row, rowField, false) : row[rowField];
      if (fieldValue === undefined || fieldValue === null) return null;
      value[scopeField] = fieldValue;
    }
    return value;
  };
  const normalizeScopeValue = (scopeName: string, scopeValue: unknown): unknown => {
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
  const isNormalizedScopeValueComplete = (scopeName: string, scopeValue: unknown): boolean => {
    const by = scopeByFieldMap.get(scopeName);
    if (!by || scopeValue === null) return true;
    if (!isRecord(scopeValue)) return false;
    return Object.keys(by).every(field => scopeValue[field] !== undefined && scopeValue[field] !== null);
  };
  const isScopeValueComplete = (scopeName: string, scopeValue: unknown): boolean =>
    isNormalizedScopeValueComplete(scopeName, normalizeScopeValue(scopeName, scopeValue));
  const keyForScope = (scopeName: string, scopeValue: unknown): string => {
    const normalized = normalizeScopeValue(scopeName, scopeValue);
    if (!isNormalizedScopeValueComplete(scopeName, normalized)) {
      const by = scopeByFieldMap.get(scopeName)!;
      const missing = Object.keys(by).find(field => !isRecord(normalized) || normalized[field] === undefined || normalized[field] === null)!;
      throw new Error(`${config.name}.${scopeName}: scope value must provide ${missing}`);
    }
    return compositeKey(scopeName, buildScopeKey(normalized));
  };
  return { keyForScope, normalizeScopeValue, isScopeValueComplete, scopeValueFromRow };
};
