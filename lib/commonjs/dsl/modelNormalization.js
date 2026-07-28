"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readModelField = exports.createModelNormalization = void 0;
var _logger = require("../core/logger.js");
var _writePolicies = require("../core/writePolicies.js");
var _fieldSpec = require("../schema/fieldSpec.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const readModelField = (field, input, key, complete) => {
  const value = complete ? field.read(input, key) : field[_fieldSpec.fieldSpecSparseRead](input, key);
  if (value !== undefined) return value;
  if (complete && field.factoryDefault !== undefined) return typeof field.factoryDefault === 'function' ? field.factoryDefault() : field.factoryDefault;
  if (complete && (field.mode === 'nullable' || field.mode === 'optionalNullable')) return null;
  return undefined;
};
exports.readModelField = readModelField;
const createModelNormalization = config => {
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
    return (0, _writePolicies.compileWritePolicies)(groups ?? [], config.id);
  })();
  const normalize = (input, complete = false) => {
    if (config.guard && !config.guard(input)) throw new Error(`${config.name} rejected input`);
    const id = (0, _normalizeHelpers.stringifyNullish)(config.rowId?.(input) ?? ((0, _normalizeHelpers.isRecord)(input) ? input.id : undefined));
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${config.name} requires id`);
    const output = {
      id
    };
    for (const [key, field] of Object.entries(config.fields)) {
      const value = readModelField(field, input, key, complete);
      if (value !== undefined) output[key] = value;
    }
    return output;
  };
  const isPlanRow = value => {
    try {
      normalize(value);
      return true;
    } catch (error) {
      (0, _logger.getDbLogger)().error(`[${config.name}] plan row rejected`, {
        error
      });
      return false;
    }
  };
  return {
    applyWriteGate,
    isPlanRow,
    normalize
  };
};
exports.createModelNormalization = createModelNormalization;
//# sourceMappingURL=modelNormalization.js.map