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

/**
 * Build field specs for declarative `defineModel({ fields })` schemas.
 *
 * Each builder reads from `input[key]` unless `.from(...)` changes the source.
 */
export const f = {
  /**
   * Read string values and skip every other input type.
   *
   * `null` is skipped until `.nullable()` or `.nullDefault()` is applied.
   *
   * @returns A field spec that stores `string`.
   */
  str: () => valueField(readString, readNullableString),
  /**
   * Read number values and skip every other input type.
   *
   * `null` is skipped until `.nullable()` or `.nullDefault()` is applied.
   *
   * @returns A field spec that stores `number`.
   */
  num: () => valueField(readNumber, readNullableNumber),
  /**
   * Read boolean values and skip every other input type.
   *
   * `null` is skipped until `.nullable()` is applied.
   *
   * @returns A field spec that stores `boolean`.
   */
  bool: () => valueField(readBoolean),
  /**
   * Read string or number ids and normalize them to strings.
   *
   * Empty, nullish, and non-scalar values are skipped.
   *
   * @returns A field spec that stores a string id.
   */
  id: () => valueField(readId),
  /**
   * Pass through non-nullish enum values as the supplied TypeScript enum type.
   *
   * Runtime validation is intentionally delegated to the caller or GraphQL types.
   *
   * @returns A field spec that stores the supplied enum type.
   */
  enum: () => valueField(definedPassthrough),
  /**
   * Pass through any non-nullish raw value as the supplied TypeScript type.
   *
   * Use for JSON blobs or arrays that should not be normalized by field readers.
   *
   * @returns A field spec that stores the supplied raw type.
   */
  raw: () => valueField(definedPassthrough),
  /**
   * Read a value from the whole input object with a custom selector.
   *
   * Returning `undefined` skips the field; returning `null` is preserved only after `.nullable()`.
   *
   * @param read Selector that receives the full input object.
   * @returns A field spec that stores the selector output type.
   */
  custom: read => customField(input => read(input)),
  /**
   * Read a nested object through a reusable shape.
   *
   * Non-object and null inputs are skipped unless `.nullable()` or `.emptyDefault()` changes build-time behavior.
   *
   * @param shape Shape created by `defineShape`.
   * @returns A field spec that stores the shape output object.
   */
  object: shape => objectField(shape),
  /**
   * Read arrays of shapes or scalar field specs and drop unreadable elements.
   *
   * Non-array inputs are skipped; null elements are never kept.
   *
   * @param item Shape or scalar field spec used to read each array element.
   * @returns A field spec that stores an array of readable element outputs.
   */
  array: item => valueField(readArray(item))
};
//# sourceMappingURL=f.js.map