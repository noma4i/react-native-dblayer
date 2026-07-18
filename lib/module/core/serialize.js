"use strict";

import { isRecord } from "../utils/normalizeHelpers.js";

/** Serialize a value with stable object-key ordering. */
export const stableSerialize = value => {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
//# sourceMappingURL=serialize.js.map