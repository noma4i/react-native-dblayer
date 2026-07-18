"use strict";

/**
 * Returns whether every requested stored field is present on a row.
 * `undefined` is missing; `null` is a present stored value.
 */
export const hasRequiredFields = (row, fields) => row != null && fields.every(field => row[field] !== undefined);
//# sourceMappingURL=requireFields.js.map