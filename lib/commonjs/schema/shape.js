"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readShapeOrThrow = exports.readShape = exports.projectShape = exports.defineShape = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
/**
 * Define a reusable field group for model fields, object fields, and array items.
 *
 * @param fields Field specs keyed by stored nested-object properties.
 * @returns Shape metadata whose type-only branded `fields` retain `TInput` when passed to `defineModel`.
 */
const defineShape = () => fields => ({
  fields: fields
});

/**
 * Read an unknown payload through a shape and drop unreadable fields.
 *
 * Shape reads are dense row projections: field-level null defaults and other
 * reader defaults are applied to build a full shape object.
 *
 * @param shape Shape created by `defineShape`.
 * @param input Candidate object payload; non-objects and arrays return `undefined`.
 * @returns The normalized shape object, or `undefined` when the payload is not an object.
 */
exports.defineShape = defineShape;
const readShape = (shape, input) => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(input)) return undefined;
  const output = {};
  for (const key of Object.keys(shape.fields)) {
    const value = shape.fields[key].read(input, key);
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
};

/**
 * Read an unknown payload through a shape or throw a labelled error.
 *
 * @param shape Shape created by `defineShape`.
 * @param input Candidate object payload.
 * @param label Error prefix used when the payload is unreadable.
 * @returns The normalized shape object.
 */
exports.readShape = readShape;
const readShapeOrThrow = (shape, input, label) => {
  const result = readShape(shape, input);
  if (result == null) {
    throw new Error(`${label}: invalid shape payload`);
  }
  return result;
};

/**
 * Project a wider source object into a shape's field set and apply overrides last.
 *
 * @param shape Shape created by `defineShape`.
 * @param source Source object containing at least some shape fields.
 * @param overrides Typed stored-field overrides that win over source values.
 * @returns The normalized shape projection.
 */
exports.readShapeOrThrow = readShapeOrThrow;
const projectShape = (shape, source, overrides) => readShape(shape, {
  ...source,
  ...overrides
});
exports.projectShape = projectShape;
//# sourceMappingURL=shape.js.map