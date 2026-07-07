"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createSchema = exports.compositeId = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const normalizeId = value => {
  const id = (0, _normalizeHelpers.toStr)(value);
  if (!id) return null;
  return id;
};
const compositeId = (...selectors) => input => {
  if (!selectors.length) return null;
  const parts = [];
  for (const selector of selectors) {
    let value;
    try {
      value = selector(input);
    } catch {
      return null;
    }
    const part = normalizeId(value);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join(':');
};
exports.compositeId = compositeId;
const createSchema = config => ({
  fields: config.fields,
  normalize(input) {
    if (config.guard && !config.guard(input)) return null;
    const id = normalizeId(config.rowId ? config.rowId(input) : input.id);
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