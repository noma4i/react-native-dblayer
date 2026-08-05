"use strict";

import { getDbLogger } from "../core/logger.js";
import { putQuarantine } from "../core/quarantine.js";
import { compileWritePolicies } from "../core/writePolicies.js";
import { scalarFieldCodecs } from "../schema/fieldCodec.js";
import { fieldSpecSparseRead } from "../schema/fieldSpec.js";
import { isRecord } from "../utils/normalizeHelpers.js";
export const readModelField = (field, input, key, complete) => {
  const value = complete ? field.read(input, key) : field[fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};
export const createModelNormalization = config => {
  for (const field of Object.keys(config.fields)) {
    if (field === 'orderKey' || field.startsWith('$')) throw new Error(`${config.name} field ${field} is reserved by the store plane`);
  }
  const applyWriteGate = (() => {
    const groups = config.write?.groups;
    if (config.write && (!groups || groups.length === 0)) throw new Error(`${config.name} write groups must not be empty`);
    const declaredFields = new Set(Object.keys(config.fields));
    const groupedFields = new Set();
    for (const group of groups ?? []) {
      if (group.fields.length === 0) throw new Error(`${config.name} write groups must not be empty`);
      for (const field of group.fields) {
        if (!declaredFields.has(field)) throw new Error(`${config.name} write field ${field} is not declared`);
        if (groupedFields.has(field)) throw new Error(`${config.name} write field ${field} appears in more than one group`);
        groupedFields.add(field);
      }
    }
    return compileWritePolicies(groups ?? [], config.id);
  })();
  const normalize = (input, complete = false) => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = scalarFieldCodecs.id.read(config.rowId?.(input) ?? (isRecord(input) ? input.id : undefined));
    if (id === undefined) throw new Error(`${config.name} requires id`);
    const output = {
      id
    };
    for (const [key, field] of Object.entries(config.fields)) {
      const value = readModelField(field, input, key, complete);
      if (value !== undefined) output[key] = value;
    }
    return output;
  };

  /** THE plan-row admission seam: a row that fails validation is quarantined with a ticket, never silently dropped. */
  const admitPlanRow = value => {
    try {
      return normalize(value);
    } catch (error) {
      getDbLogger().error(`[${config.name}] plan row rejected`, {
        error
      });
      putQuarantine({
        kind: 'row',
        model: config.id,
        id: isRecord(value) && value.id !== undefined ? String(value.id) : '',
        raw: value,
        reason: 'plan-row-rejected'
      });
      return undefined;
    }
  };
  return {
    applyWriteGate,
    admitPlanRow,
    normalize
  };
};
//# sourceMappingURL=modelNormalization.js.map