import type { SparseModelField, InferStoredFields, ModelConfig, ModelFieldSpecs, ModelNormalization } from '../types';
import { getDbLogger } from '../core/logger';
import { putQuarantine } from '../core/quarantine';
import { compileWritePolicies } from '../core/writePolicies';
import { scalarFieldCodecs } from '../schema/fieldCodec';
import { fieldSpecSparseRead } from '../schema/fieldSpec';
import { isRecord } from '../utils/normalizeHelpers';
export const readModelField = (field: ModelFieldSpecs[string], input: unknown, key: string, complete: boolean): unknown => {
  const value = complete ? field.read(input, key) : (field as SparseModelField)[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

export const createModelNormalization = <
  TFields extends ModelFieldSpecs,
  TScopeNames extends string,
  TExt extends Record<string, unknown>
>(
  config: ModelConfig<TFields, TScopeNames, TExt, any>
): ModelNormalization<InferStoredFields<TFields> & Record<string, unknown>> => {
  const applyWriteGate = (() => {
    const groups = config.write?.groups;
    if (config.write && (!groups || groups.length === 0)) throw new Error(`${config.name} write groups must not be empty`);
    const declaredFields = new Set(Object.keys(config.fields));
    const groupedFields = new Set<string>();
    for (const group of groups ?? []) {
      if (group.fields.length === 0) throw new Error(`${config.name} write groups must not be empty`);
      for (const field of group.fields) {
        if (!declaredFields.has(field)) throw new Error(`${config.name} write field ${field} is not declared`);
        if (groupedFields.has(field)) throw new Error(`${config.name} write field ${field} appears in more than one group`);
        groupedFields.add(field);
      }
    }
    return compileWritePolicies<InferStoredFields<TFields> & Record<string, unknown>>(groups ?? [], config.id);
  })();

  const normalize = (input: unknown, complete = false): InferStoredFields<TFields> & Record<string, unknown> => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = scalarFieldCodecs.id.read(config.rowId?.(input) ?? (isRecord(input) ? input.id : undefined));
    if (id === undefined) throw new Error(`${config.name} requires id`);
    const output: Record<string, unknown> = { id };
    for (const [key, field] of Object.entries(config.fields)) {
      const value = readModelField(field as ModelFieldSpecs[string], input, key, complete);
      if (value !== undefined) output[key] = value;
    }
    return output as InferStoredFields<TFields> & Record<string, unknown>;
  };

  /** THE plan-row admission seam: a row that fails validation is quarantined with a ticket, never silently dropped. */
  const admitPlanRow = (value: unknown): (InferStoredFields<TFields> & Record<string, unknown>) | undefined => {
    try {
      return normalize(value);
    } catch (error) {
      getDbLogger().error(`[${config.name}] plan row rejected`, { error });
      putQuarantine({ kind: 'row', model: config.id, id: isRecord(value) && value.id !== undefined ? String(value.id) : '', raw: value, reason: 'plan-row-rejected' });
      return undefined;
    }
  };

  return { applyWriteGate, admitPlanRow, normalize };
};
