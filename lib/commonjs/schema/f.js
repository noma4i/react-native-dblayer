"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.f = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _fieldSpec = require("./fieldSpec.js");
var _shape = require("./shape.js");
const definedPassthrough = value => value == null ? undefined : value;
const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return (0, _normalizeHelpers.toStr)(value) ?? undefined;
};
const valueField = (readValue, readNullableValue = (0, _fieldSpec.preserveNull)(readValue)) => (0, _fieldSpec.createFieldSpec)({
  mode: 'required',
  selectSource: _fieldSpec.readObjectField,
  readValue,
  readNullableValue,
  defaultNull: false
});
const customField = readValue => (0, _fieldSpec.createFieldSpec)({
  mode: 'required',
  selectSource: input => input,
  readValue,
  readNullableValue: (0, _fieldSpec.preserveNull)(readValue),
  defaultNull: false
});
const isShape = item => !('readValue' in item);
const readObjectShape = shape => value => (0, _shape.readShape)(shape, value);
const withEmptyDefault = (shape, field) => {
  const objectSpec = field;
  objectSpec.emptyDefault = () => withEmptyDefault(shape, field.default(() => (0, _shape.readShape)(shape, {})));
  return objectSpec;
};
const objectField = shape => withEmptyDefault(shape, valueField(readObjectShape(shape)));
const readArray = item => value => {
  if (!Array.isArray(value)) return undefined;
  const output = [];
  for (const element of value) {
    const itemValue = isShape(item) ? (0, _shape.readShape)(item, element) : item.readValue(element);
    if (itemValue !== undefined && itemValue !== null) {
      output.push(itemValue);
    }
  }
  return output;
};
const f = exports.f = {
  str: () => valueField(_normalizeHelpers.readString, _normalizeHelpers.readNullableString),
  num: () => valueField(_normalizeHelpers.readNumber, _normalizeHelpers.readNullableNumber),
  bool: () => valueField(_normalizeHelpers.readBoolean),
  id: () => valueField(readId),
  enum: () => valueField(definedPassthrough),
  raw: () => valueField(definedPassthrough),
  custom: read => customField(input => read(input)),
  object: shape => objectField(shape),
  array: item => valueField(readArray(item))
};
//# sourceMappingURL=f.js.map