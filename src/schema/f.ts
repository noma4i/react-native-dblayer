import { readBoolean, readNullableNumber, readNullableString, readNumber, readString, toStr } from '../utils/normalizeHelpers';
import { createFieldSpec, preserveNull, readObjectField } from './fieldSpec';
import type { EmptyDefaultFieldSpec, FieldSpec, FieldValueReader } from './fieldSpec';
import type { AnyDbShape } from './infer';
import type { InferShapeStored } from './infer';
import { readShape } from './shape';

const definedPassthrough = <T>(value: unknown): T | undefined => (value == null ? undefined : (value as T));

type ArrayItem = AnyDbShape | FieldSpec<any, any, any, any>;
type ArrayItemOut<TItem extends ArrayItem> = TItem extends AnyDbShape ? InferShapeStored<TItem> : TItem extends FieldSpec<any, infer TOut, any, any> ? TOut : never;

const readId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return toStr(value) ?? undefined;
};

const valueField = <TOut>(readValue: FieldValueReader<TOut>, readNullableValue: FieldValueReader<TOut> = preserveNull(readValue)): FieldSpec<unknown, TOut> =>
  createFieldSpec({
    mode: 'required',
    selectSource: readObjectField,
    readValue,
    readNullableValue,
    defaultNull: false
  });

const customField = <TInput, TOut>(readValue: FieldValueReader<TOut>): FieldSpec<TInput, TOut> =>
  createFieldSpec({
    mode: 'required',
    selectSource: input => input,
    readValue,
    readNullableValue: preserveNull(readValue),
    defaultNull: false
  });

const isShape = (item: ArrayItem): item is AnyDbShape => !('readValue' in item);

const readObjectShape =
  <TShape extends AnyDbShape>(shape: TShape): FieldValueReader<InferShapeStored<TShape>> =>
  value =>
    readShape(shape, value) as InferShapeStored<TShape> | undefined;

const withEmptyDefault = <TShape extends AnyDbShape>(shape: TShape, field: FieldSpec<unknown, InferShapeStored<TShape>, any, any>): EmptyDefaultFieldSpec<unknown, InferShapeStored<TShape>, any, any> => {
  const objectSpec = field as EmptyDefaultFieldSpec<unknown, InferShapeStored<TShape>, any, any>;
  objectSpec.emptyDefault = () => withEmptyDefault(shape, field.default(() => readShape(shape, {}) as InferShapeStored<TShape>));
  return objectSpec;
};

const objectField = <TShape extends AnyDbShape>(shape: TShape): EmptyDefaultFieldSpec<unknown, InferShapeStored<TShape>> =>
  withEmptyDefault(shape, valueField<InferShapeStored<TShape>>(readObjectShape(shape))) as EmptyDefaultFieldSpec<unknown, InferShapeStored<TShape>>;

const readArray =
  <TItem extends ArrayItem>(item: TItem): FieldValueReader<ArrayItemOut<TItem>[]> =>
  value => {
    if (!Array.isArray(value)) return undefined;

    const output: Array<ArrayItemOut<TItem>> = [];

    for (const element of value) {
      const itemValue = isShape(item) ? readShape(item, element) : item.readValue(element);
      if (itemValue !== undefined && itemValue !== null) {
        output.push(itemValue as ArrayItemOut<TItem>);
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
  enum: <T>() => valueField<T>(definedPassthrough),
  /**
   * Pass through any non-nullish raw value as the supplied TypeScript type.
   *
   * Use for JSON blobs or arrays that should not be normalized by field readers.
   *
   * @returns A field spec that stores the supplied raw type.
   */
  raw: <T>() => valueField<T>(definedPassthrough),
  /**
   * Read a value from the whole input object with a custom selector.
   *
   * Returning `undefined` skips the field; returning `null` is preserved only after `.nullable()`.
   *
   * @param read Selector that receives the full input object.
   * @returns A field spec that stores the selector output type.
   */
  custom: <TOut, TInput = unknown>(read: (input: TInput) => TOut | null | undefined) => customField<TInput, TOut>(input => read(input as TInput)),
  /**
   * Read a nested object through a reusable shape.
   *
   * Non-object and null inputs are skipped unless `.nullable()` or `.emptyDefault()` changes build-time behavior.
   *
   * @param shape Shape created by `defineShape`.
   * @returns A field spec that stores the shape output object.
   */
  object: <TShape extends AnyDbShape>(shape: TShape) => objectField(shape),
  /**
   * Read arrays of shapes or scalar field specs and drop unreadable elements.
   *
   * Non-array inputs are skipped; null elements are never kept.
   *
   * @param item Shape or scalar field spec used to read each array element.
   * @returns A field spec that stores an array of readable element outputs.
   */
  array: <TItem extends ArrayItem>(item: TItem) => valueField<ArrayItemOut<TItem>[]>(readArray(item))
};
