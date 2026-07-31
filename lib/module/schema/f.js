"use strict";

import { createEnumFieldCodec, defineFieldCodec, scalarFieldCodecs } from "./fieldCodec.js";
import { createFieldSpec, readObjectField } from "./fieldSpec.js";
import { readShape } from "./shape.js";
const definedPassthrough = value => value == null ? undefined : value;
const valueField = (kind, readValue) => createFieldSpec({
  kind,
  mode: 'required',
  selectSource: readObjectField,
  codec: defineFieldCodec(readValue),
  defaultNull: false
});
const customField = (kind, readValue) => createFieldSpec({
  kind,
  mode: 'required',
  selectSource: input => input,
  codec: defineFieldCodec(readValue),
  derived: true,
  defaultNull: false
});
const isShape = item => !('readValue' in item);
const readObjectShape = shape => value => readShape(shape, value);
const withEmptyDefault = (shape, field) => {
  const objectSpec = field;
  objectSpec.emptyDefault = () => withEmptyDefault(shape, field.default(() => readShape(shape, {})));
  return objectSpec;
};
const objectField = shape => withEmptyDefault(shape, valueField('object', readObjectShape(shape)));
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
  str: () => valueField('str', scalarFieldCodecs.str.read),
  /**
   * Convert finite numbers and non-blank numeric strings to stored numbers and canonicalize negative zero to zero.
   *
   * `null` is skipped until `.nullable()` or `.nullDefault()` is applied.
   *
   * @returns A field spec that stores `number`.
   */
  num: () => valueField('num', scalarFieldCodecs.num.read),
  /**
   * Convert safe integer numbers and integer strings to stored numbers.
   *
   * Fractional, blank, non-finite, and unsafe values are skipped.
   *
   * @returns A field spec that stores a safe integer.
   */
  int: () => valueField('int', scalarFieldCodecs.int.read),
  /**
   * ISO-8601 date-time string field. Strings are kept as-is when parseable; `Date` instances and
   * epoch-milliseconds numbers are stored as `toISOString()`; unparseable values are dropped.
   * Stored as a string, so codepoint ordering (orderBy, DbWhereOp gt/lt) is chronological for
   * same-format ISO values.
   */
  date: () => valueField('date', scalarFieldCodecs.date.read),
  /**
   * Convert boolean values and the strings `"true"`/`"false"` to stored booleans.
   *
   * `null` is skipped until `.nullable()` is applied.
   *
   * @returns A field spec that stores `boolean`.
   */
  bool: () => valueField('bool', scalarFieldCodecs.bool.read),
  /**
   * Read string or number ids and normalize them to strings.
   *
   * Empty, nullish, and non-scalar values are skipped.
   *
   * @returns A field spec that stores a string id.
   */
  id: () => valueField('id', scalarFieldCodecs.id.read),
  /**
   * Enum field with runtime validation: only the declared string values are stored; any other value
   * is dropped like other unreadable values. The stored type is the union of the declared literals -
   * pass an explicit generic for codegen enums: `f.enum<GqlKind>(Object.values(GqlKind))`.
   */
  enum: values => {
    return valueField('enum', createEnumFieldCodec(values).read);
  },
  /**
   * Pass through any non-nullish raw value as the supplied TypeScript type.
   *
   * Use for JSON blobs or arrays that should not be normalized by field readers. Durable writes
   * reject values that cannot survive an exact JSON round-trip.
   *
   * @returns A field spec that stores the supplied raw type.
   */
  raw: () => valueField('raw', definedPassthrough),
  /**
   * Read a value from the whole input object with a custom selector.
   *
   * Returning `undefined` skips the field; returning `null` is preserved only after `.nullable()`.
   *
   * @param read Selector that receives the full input object.
   * @returns A field spec that stores the selector output type.
   */
  custom: read => customField('custom', input => read(input)),
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
  array: item => valueField('array', readArray(item))
};
//# sourceMappingURL=f.js.map