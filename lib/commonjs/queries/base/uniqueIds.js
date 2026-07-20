"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.emptyIds = exports.dedupeIds = void 0;
var _esToolkit = require("es-toolkit");
/** Shared immutable empty id list for stable fallback reads. */
const emptyIds = exports.emptyIds = [];

/**
 * Return unique non-empty ids in first-seen order.
 *
 * @param ids Candidate ids that may be nullish or duplicated.
 * @returns A new array containing each truthy id once.
 */
const dedupeIds = ids => (0, _esToolkit.uniq)(ids.filter(id => Boolean(id)));
exports.dedupeIds = dedupeIds;
//# sourceMappingURL=uniqueIds.js.map