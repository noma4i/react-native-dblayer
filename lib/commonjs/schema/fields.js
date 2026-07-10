"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineFields = void 0;
/** Field map carrying the raw input type used by model normalization. */

/** Infer the branded raw input type of a field map, or `unknown` for a plain map. */

/**
 * Attach a raw input type to a declarative field map without changing it at runtime.
 *
 * Plain field maps remain valid and normalize `unknown`. Use this helper when callers of
 * `Model.normalize` should be checked against a concrete transport or domain input contract.
 *
 * @returns A field-map factory that preserves the provided fields and brands their input type.
 */
const defineFields = () => fields => fields;
exports.defineFields = defineFields;
//# sourceMappingURL=fields.js.map