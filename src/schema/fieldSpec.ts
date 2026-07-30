import { isRecord } from '../utils/normalizeHelpers';
import type { FieldMode, FieldSpec, FieldSpecOptions, NullableMode, OptionalMode } from '../types';

/** Select the raw source value for a field from an input object and key. */
export const fieldSpecSparseRead = Symbol('fieldSpecSparseRead');

/** Read `input[key]` when input is an object, otherwise return undefined. */
export const readObjectField = <TInput>(input: TInput, key: string): unknown => {
  if (!isRecord(input)) return undefined;
  return input[key];
};

/** Read an own key from a source object, otherwise return undefined. */
const readSourceKey = (source: unknown, key: string): unknown => {
  if (!isRecord(source)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  return source[key];
};

const nullableMode = <TMode extends FieldMode>(mode: TMode): NullableMode<TMode> => (mode === 'optional' || mode === 'optionalNullable' ? 'optionalNullable' : 'nullable') as NullableMode<TMode>;

const optionalMode = <TMode extends FieldMode>(mode: TMode): OptionalMode<TMode> => (mode === 'nullable' || mode === 'optionalNullable' ? 'optionalNullable' : 'optional') as OptionalMode<TMode>;

/** Create a chainable field spec from low-level reader functions. */
export const createFieldSpec = <TInput, TOut, TMode extends FieldMode, THasDefault extends boolean = false>(
  options: FieldSpecOptions<TInput, TOut, TMode>
): FieldSpec<TInput, TOut, TMode, THasDefault> => {
  const acceptsNull = options.mode === 'nullable' || options.mode === 'optionalNullable';
  const spec = {
    kind: options.kind,
    mode: options.mode,
    hasDefault: options.defaultNull || Object.prototype.hasOwnProperty.call(options, 'factoryDefault'),
    derived: options.derived,
    readValue(value) {
      if (value === null) return acceptsNull ? null : undefined;
      const output = options.codec.read(value);
      if (output === null) return acceptsNull ? null : undefined;
      if (output === undefined && options.defaultNull && value === undefined) return null;
      return output;
    },
    [fieldSpecSparseRead](input: TInput, key: string) {
      try {
        return spec.readValue(options.selectSource(input, key));
      } catch {
        return undefined;
      }
    },
    read(input, key) {
      try {
        const source = options.selectSource(input, key);
        return spec.readValue(source);
      } catch {
        return undefined;
      }
    },
    nullable() {
      return createFieldSpec<TInput, TOut, NullableMode<TMode>, THasDefault>({
        ...options,
        mode: nullableMode(options.mode)
      });
    },
    optional() {
      return createFieldSpec<TInput, TOut, OptionalMode<TMode>, THasDefault>({
        ...options,
        mode: optionalMode(options.mode)
      });
    },
    nullDefault() {
      return createFieldSpec<TInput, TOut, 'nullable', THasDefault>({
        ...options,
        mode: 'nullable',
        defaultNull: true
      });
    },
    default(value) {
      return createFieldSpec<TInput, TOut, TMode, true>({
        ...options,
        factoryDefault: value
      });
    },
    from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) =>
      createFieldSpec<TNextInput, TOut, TMode, THasDefault>({
        ...options,
        selectSource: input => selector(input)
      }),
    fromKey: <TNextInput = TInput>(key: string, source?: (input: TNextInput) => unknown) =>
      createFieldSpec<TNextInput, TOut, TMode, THasDefault>({
        ...options,
        selectSource: input => readSourceKey(source ? source(input) : input, key)
      })
  } as FieldSpec<TInput, TOut, TMode, THasDefault> & {
    [fieldSpecSparseRead]: (input: TInput, key: string) => TOut | null | undefined;
  };

  if (Object.prototype.hasOwnProperty.call(options, 'factoryDefault')) {
    spec.factoryDefault = options.factoryDefault;
  }

  return spec;
};
