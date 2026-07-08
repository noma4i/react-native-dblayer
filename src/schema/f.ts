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

export const f = {
  str: () => valueField(readString, readNullableString),
  num: () => valueField(readNumber, readNullableNumber),
  bool: () => valueField(readBoolean),
  id: () => valueField(readId),
  enum: <T>() => valueField<T>(definedPassthrough),
  raw: <T>() => valueField<T>(definedPassthrough),
  custom: <TOut, TInput = unknown>(read: (input: TInput) => TOut | null | undefined) => customField<TInput, TOut>(input => read(input as TInput)),
  object: <TShape extends AnyDbShape>(shape: TShape) => objectField(shape),
  array: <TItem extends ArrayItem>(item: TItem) => valueField<ArrayItemOut<TItem>[]>(readArray(item))
};
