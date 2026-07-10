"use strict";

import { toStr } from "../utils/normalizeHelpers.js";
import { readObjectField, readSourceKey } from "./fieldSpec.js";
const normalizeId = value => {
  const id = toStr(value);
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

export function compositeId(...parts) {
  return input => {
    if (!parts.length) return null;
    const normalizedParts = [];
    for (const partReader of parts) {
      let value;
      try {
        value = typeof partReader === 'string' ? readSourceKey(input, partReader) : partReader(input);
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