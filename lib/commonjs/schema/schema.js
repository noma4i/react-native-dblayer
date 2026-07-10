"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.compositeId = compositeId;
exports.createSchema = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _fieldSpec = require("./fieldSpec.js");
const normalizeId = value => {
  const id = (0, _normalizeHelpers.toStr)(value);
  if (!id) return null;
  return id;
};

/** A row source must be a non-null object; guard/rowId/field readers assume object shape. */
const isNormalizableInput = input => typeof input === 'object' && input !== null;

/**
 * Build a row-id resolver by joining normalized own-key reads or selector outputs with `:`.
 *
 * @param parts Own-property keys or functions that read id parts from an input object.
 * @returns A resolver that returns `null` when any key/selector is unreadable or yields an empty part.
 */

function compositeId(...parts) {
  return input => {
    if (!parts.length) return null;
    const normalizedParts = [];
    for (const partReader of parts) {
      let value;
      try {
        value = typeof partReader === 'string' ? (0, _fieldSpec.readSourceKey)(input, partReader) : partReader(input);
      } catch {
        return null;
      }
      const part = normalizeId(value);
      if (part === null) return null;
      normalizedParts.push(part);
    }
    return normalizedParts.join(':');
  };
}
const createSchema = config => ({
  fields: config.fields,
  normalize(input) {
    if (!isNormalizableInput(input)) return null;
    if (config.guard && !config.guard(input)) return null;
    const id = normalizeId(config.rowId ? config.rowId(input) : (0, _fieldSpec.readObjectField)(input, 'id'));
    if (id === null) return null;
    const output = {
      id
    };
    for (const key of Object.keys(config.fields)) {
      const value = config.fields[key].read(input, key);
      if (value !== undefined) {
        output[key] = value;
      }
    }
    return output;
  }
});
exports.createSchema = createSchema;
//# sourceMappingURL=schema.js.map