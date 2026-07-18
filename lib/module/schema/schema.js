"use strict";

import { toStr } from "../utils/normalizeHelpers.js";
import { readObjectField } from "./fieldSpec.js";
const normalizeId = value => {
  const id = toStr(value);
  if (!id) return null;
  return id;
};

/** A row source must be a non-null object; guard/rowId/field readers assume object shape. */
const isNormalizableInput = input => typeof input === 'object' && input !== null;
export const createSchema = config => ({
  fields: config.fields,
  normalize(input) {
    if (!isNormalizableInput(input)) return null;
    if (config.guard && !config.guard(input)) return null;
    const id = normalizeId(config.rowId ? config.rowId(input) : readObjectField(input, 'id'));
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
//# sourceMappingURL=schema.js.map