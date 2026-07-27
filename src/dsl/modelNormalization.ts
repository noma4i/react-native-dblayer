import type { ModelFieldSpecs } from '../types';
import { getDbLogger } from '../core/logger';
import { fieldSpecSparseRead } from '../schema/fieldSpec';
import { isRecord, stringifyNullish } from '../utils/normalizeHelpers';
import type { InferStoredFields } from '../schema/infer';
import type { ScopeSpec } from './scope';
import type { ModelConfig, WriteCtx } from './defineModel';

type SparseModelField = ModelFieldSpecs[string] & { [fieldSpecSparseRead]: (value: unknown, fieldKey: string) => unknown };

export const readModelField = (field: ModelFieldSpecs[string], input: unknown, key: string, complete: boolean): unknown => {
  const value = complete ? field.read(input, key) : (field as SparseModelField)[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};

export const createModelNormalization = <
  TFields extends ModelFieldSpecs,
  TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>>,
  TExt extends Record<string, unknown>
>(
  config: ModelConfig<TFields, TScopes, TExt, any>
) => {
  type Stored = InferStoredFields<TFields> & Record<string, unknown>;
  const applyWriteGate = (() => {
    if (!config.write) return undefined;
    const groups = config.write.groups;
    if (groups && groups.length === 0) throw new Error(`${config.name} write groups must not be empty`);
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
    return (previous: Stored, incoming: Stored, ctx: WriteCtx): Stored | null => {
      if (ctx.origin !== 'replace' && config.write?.accept && !config.write.accept(previous, incoming, ctx)) return null;
      const effective: Stored = { ...previous, ...incoming };
      const writableEffective = effective as Record<string, unknown>;
      for (const group of groups ?? []) {
        if (group.policy === 'server') continue;
        if (group.policy === 'continuity') {
          for (const field of group.fields) if (field in incoming && (incoming[field] === undefined || incoming[field] === null)) writableEffective[field] = previous[field];
          continue;
        }
        if ('monotonic' in group.policy) {
          const changed = group.fields.some(field => field in incoming && !Object.is(incoming[field], previous[field]));
          if (changed && !group.policy.monotonic(incoming, previous, ctx)) {
            for (const field of group.fields) writableEffective[field] = previous[field];
          }
          continue;
        }
        for (const field of group.fields) {
          if (!(field in incoming)) continue;
          const value = group.policy.merge(previous[field], incoming[field], ctx);
          writableEffective[field] = value === undefined ? previous[field] : value;
        }
      }
      return effective;
    };
  })();

  const normalize = (input: unknown, complete = false): Stored => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = stringifyNullish(config.rowId?.(input) ?? (isRecord(input) ? input.id : undefined));
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${config.name} requires id`);
    const output: Record<string, unknown> = { id };
    for (const [key, field] of Object.entries(config.fields)) {
      const value = readModelField(field as ModelFieldSpecs[string], input, key, complete);
      if (value !== undefined) output[key] = value;
    }
    return output as Stored;
  };

  const isPlanRow = (value: unknown): boolean => {
    try {
      normalize(value);
      return true;
    } catch (error) {
      getDbLogger().error(`[${config.name}] plan row rejected`, { error });
      return false;
    }
  };

  return { applyWriteGate, isPlanRow, normalize };
};
