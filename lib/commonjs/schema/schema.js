'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.createSchema = void 0;
var _normalizeHelpers = require('../utils/normalizeHelpers.js');
var _fieldSpec = require('./fieldSpec.js');
const normalizeId = value => {
  const id = (0, _normalizeHelpers.toStr)(value);
  if (!id) return null;
  return id;
};

/** A row source must be a non-null object; guard/rowId/field readers assume object shape. */
const isNormalizableInput = input => typeof input === 'object' && input !== null;
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
