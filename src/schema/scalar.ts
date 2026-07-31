import type { ScalarValue } from '../types';
import { createEnumFieldCodec, scalarFieldCodecs } from './fieldCodec';

const createScalarValue = <TValue>(codec: { read: (value: unknown) => TValue | undefined }, errorMessage: (label: string) => string): ScalarValue<TValue> => ({
  read: codec.read,
  require: (value, label) => {
    const parsed = codec.read(value);
    if (parsed === undefined) throw new Error(errorMessage(label));
    return parsed;
  }
});

/**
 * Read individual transport values through the same codecs as `f.*` fields.
 *
 * `read` returns the stored scalar type or `undefined`; `require` returns the stored type or throws
 * an error naming the invalid input.
 */
export const scalar = {
  str: createScalarValue(scalarFieldCodecs.str, label => `${label} must be a string`),
  num: createScalarValue(scalarFieldCodecs.num, label => `${label} must be a finite number`),
  int: createScalarValue(scalarFieldCodecs.int, label => `${label} must be a safe integer`),
  date: createScalarValue(scalarFieldCodecs.date, label => `${label} must be a valid date`),
  bool: createScalarValue(scalarFieldCodecs.bool, label => `${label} must be a boolean`),
  id: createScalarValue(scalarFieldCodecs.id, label => `${label} is required`),
  enum: <TValue extends string>(values: readonly TValue[]): ScalarValue<TValue> =>
    createScalarValue(createEnumFieldCodec(values), label => `${label} must be one of the declared values`)
};
