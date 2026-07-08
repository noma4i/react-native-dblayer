"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readShapeOrThrow = exports.readShape = exports.readFieldsPatch = exports.projectShape = exports.defineShape = void 0;
var _fieldSpec = require("./fieldSpec.js");
const isReadableObject = input => typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * Define a reusable nested field group for object and array fields.
 *
 * @param fields Field specs keyed by stored nested-object properties.
 * @returns Shape metadata consumable by `f.object`, `f.array`, and shape readers.
 */
const defineShape = () => fields => ({
  fields
});

/**
 * Read an unknown payload through a shape and drop unreadable fields.
 *
 * Unlike `readFieldsPatch`, shape reads are dense row projections: field-level null defaults and other
 * reader defaults are applied to build a full shape object.
 *
 * @param shape Shape created by `defineShape`.
 * @param input Candidate object payload; non-objects and arrays return `undefined`.
 * @returns The normalized shape object, or `undefined` when the payload is not an object.
 */
exports.defineShape = defineShape;
const readShape = (shape, input) => {
  if (!isReadableObject(input)) return undefined;
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
 * Read sparse field updates from an unknown payload.
 *
 * Unlike `readShape`, this patch reader returns only fields whose readers produced a defined value.
 * Field defaults are not applied; explicit `null` is preserved when the field reader returns `null`.
 *
 * @param fields Field specs keyed by stored row properties.
 * @param input Candidate payload passed unchanged to every field reader.
 * @returns A sparse patch containing only defined reader outputs.
 */
exports.readShape = readShape;
const readFieldsPatch = (fields, input) => {
  const output = {};
  for (const key of Object.keys(fields)) {
    const field = fields[key];
    const value = field[_fieldSpec.fieldSpecSparseRead] ? field[_fieldSpec.fieldSpecSparseRead](input, key) : field.read(input, key);
    if (value !== undefined) output[key] = value;
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
exports.readFieldsPatch = readFieldsPatch;
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