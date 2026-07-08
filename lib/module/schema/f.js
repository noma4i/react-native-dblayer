"use strict";

import { readBoolean, readNullableNumber, readNullableString, readNumber, readString, toStr } from "../utils/normalizeHelpers.js";
import { createFieldSpec, preserveNull, readObjectField } from "./fieldSpec.js";
import { readShape } from "./shape.js";
const definedPassthrough = value => value == null ? undefined : value;
const readId = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return toStr(value) ?? undefined;
};
const valueField = (readValue, readNullableValue = preserveNull(readValue)) => createFieldSpec({
  mode: 'required',
  selectSource: readObjectField,
  readValue,
  readNullableValue,
  defaultNull: false
});
const customField = readValue => createFieldSpec({
  mode: 'required',
  selectSource: input => input,
  readValue,
  readNullableValue: preserveNull(readValue),
  defaultNull: false
});
const isShape = item => !('readValue' in item);
const readObjectShape = shape => value => readShape(shape, value);
const withEmptyDefault = (shape, field) => {
  const objectSpec = field;
  objectSpec.emptyDefault = () => withEmptyDefault(shape, field.default(() => readShape(shape, {})));
  return objectSpec;
};
const objectField = shape => withEmptyDefault(shape, valueField(readObjectShape(shape)));
const readArray = item => value => {
  if (!Array.isArray(value)) return undefined;
  const output = [];
  for (const element of value) {
    const itemValue = isShape(item) ? readShape(item, element) : item.readValue(element);
    if (itemValue !== undefined && itemValue !== null) {
      output.push(itemValue);
    }
  }
  return output;
};
export const f = {
  str: () => valueField(readString, readNullableString),
  num: () => valueField(readNumber, readNullableNumber),
  bool: () => valueField(readBoolean),
  id: () => valueField(readId),
  enum: () => valueField(definedPassthrough),
  raw: () => valueField(definedPassthrough),
  custom: read => customField(input => read(input)),
  object: shape => objectField(shape),
  array: item => valueField(readArray(item))
};
//# sourceMappingURL=f.js.map