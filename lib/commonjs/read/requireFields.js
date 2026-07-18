"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.hasRequiredFields = void 0;
/**
 * Returns whether every requested stored field is present on a row.
 * `undefined` is missing; `null` is a present stored value.
 */
const hasRequiredFields = (row, fields) => row != null && fields.every(field => row[field] !== undefined);
exports.hasRequiredFields = hasRequiredFields;
//# sourceMappingURL=requireFields.js.map