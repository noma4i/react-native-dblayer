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

/**
 * Build a row-id resolver by joining normalized selector outputs with `:`.
 *
 * @param selectors Functions that read id parts from an input object.
 * @returns A resolver that returns `null` when any selector fails or yields an empty id part.
 */
export const compositeId = (...selectors) => input => {
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