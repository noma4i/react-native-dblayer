"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.stableSerialize = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
/** Serialize a value with stable object-key ordering. */
const stableSerialize = value => {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if ((0, _normalizeHelpers.isRecord)(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
exports.stableSerialize = stableSerialize;
//# sourceMappingURL=serialize.js.map