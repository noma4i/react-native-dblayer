export type FieldMode = 'required' | 'nullable' | 'optional' | 'optionalNullable';
export type FieldDefault<TOut> = TOut | (() => TOut);

type NullableMode<TMode extends FieldMode> = TMode extends 'optional' | 'optionalNullable' ? 'optionalNullable' : 'nullable';
type OptionalMode<TMode extends FieldMode> = TMode extends 'nullable' | 'optionalNullable' ? 'optionalNullable' : 'optional';

export interface FieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> {
  /** Read this field from a full input object and object key. */
  read: (input: TInput, key: string) => TOut | null | undefined;
  /** Read this field from an already-selected raw value. */
  readValue: FieldValueReader<TOut>;
  /** Current presence mode used by normalize and buildStored. */
  mode: TMode;
  /** Factory-time default used by buildStored when the caller omits this key. */
  factoryDefault?: FieldDefault<TOut>;
  /**
   * Preserve explicit `null` during normalize while still skipping `undefined`.
   *
   * buildStored fills omitted nullable fields with `null` unless `.default(...)` is present.
   *
   * @returns A field spec whose stored type includes `null`.
   */
  nullable: () => FieldSpec<TInput, TOut, NullableMode<TMode>, THasDefault>;
  /**
   * Allow normalize and buildStored to omit this key.
   *
   * Optional fields are not required by buildStored and receive no implicit value.
   *
   * @returns A field spec whose stored key is optional.
   */
  optional: () => FieldSpec<TInput, TOut, OptionalMode<TMode>, THasDefault>;
  /**
   * Convert missing or undefined normalize input to `null`.
   *
   * buildStored also fills omitted nullable fields with `null` unless `.default(...)` is present.
   *
   * @returns A nullable field spec that defaults missing normalize input to `null`.
   */
  nullDefault: () => FieldSpec<TInput, TOut, 'nullable', THasDefault>;
  /**
   * Provide a buildStored-only default for omitted fields.
   *
   * normalize still uses the reader/nullability rules; lazy defaults run for each buildStored call.
   *
   * @param value Stored value or factory used when buildStored omits the key.
   * @returns A field spec that no longer requires this key in buildStored input.
   */
  default: (value: FieldDefault<TOut>) => FieldSpec<TInput, TOut, TMode, true>;
  /**
   * Read this field from a selector result instead of `input[key]`.
   *
   * The selected value is passed to the same field reader and nullability rules.
   *
   * @param selector Source selector that receives the full input object.
   * @returns A field spec with the same output rules and a new input type.
   */
  from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode, THasDefault>;
  /**
   * Read this field from an own property on the input or a source-selected object.
   *
   * Missing keys, nullish sources, and non-object sources resolve to `undefined`; the field reader,
   * nullability, and defaults then apply exactly as they do for `.from(...)`.
   *
   * @param key Source object key to read.
   * @param source Optional selector that receives the full input object before the key read.
   * @returns A field spec with the same output rules and a new input type.
   */
  fromKey: <TNextInput = TInput>(key: string, source?: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode, THasDefault>;
}

export interface EmptyDefaultFieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> extends FieldSpec<TInput, TOut, TMode, THasDefault> {
  /**
   * Provide a buildStored-only zero-state default for nested object fields.
   *
   * The default is produced by reading the object shape from `{}` and is recomputed per buildStored call.
   *
   * @returns An object field spec that no longer requires this key in buildStored input.
   */
  emptyDefault: () => EmptyDefaultFieldSpec<TInput, TOut, TMode, true>;
}

/** Read a selected raw value into a stored field value. */
export type FieldValueReader<TOut> = (value: unknown) => TOut | null | undefined;
/** Select the raw source value for a field from an input object and key. */
export type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;
export const fieldSpecSparseRead = Symbol('fieldSpecSparseRead');

type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
  mode: TMode;
  selectSource: FieldSourceSelector<TInput>;
  readValue: FieldValueReader<TOut>;
  readNullableValue: FieldValueReader<TOut>;
  defaultNull: boolean;
  factoryDefault?: FieldDefault<TOut>;
};

/** Read `input[key]` when input is an object, otherwise return undefined. */
export const readObjectField = <TInput>(input: TInput, key: string): unknown => {
  if (!isRecord(input)) return undefined;
  return input[key];
};

/** Read an own key from a source object, otherwise return undefined. */
export const readSourceKey = (source: unknown, key: string): unknown => {
  if (!isRecord(source)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  return source[key];
};

const nullableMode = <TMode extends FieldMode>(mode: TMode): NullableMode<TMode> => (mode === 'optional' || mode === 'optionalNullable' ? 'optionalNullable' : 'nullable') as NullableMode<TMode>;

const optionalMode = <TMode extends FieldMode>(mode: TMode): OptionalMode<TMode> => (mode === 'nullable' || mode === 'optionalNullable' ? 'optionalNullable' : 'optional') as OptionalMode<TMode>;

/** Wrap a value reader so explicit null is preserved. */
export const preserveNull = <TOut>(readValue: FieldValueReader<TOut>): FieldValueReader<TOut> => value => {
  if (value === null) return null;
  return readValue(value);
};

/** Create a chainable field spec from low-level reader functions. */
export const createFieldSpec = <TInput, TOut, TMode extends FieldMode, THasDefault extends boolean = false>(
  options: FieldSpecOptions<TInput, TOut, TMode>
): FieldSpec<TInput, TOut, TMode, THasDefault> => {
  const spec = {
    mode: options.mode,
    readValue(value) {
      const output = options.readValue(value);
      if (output === undefined && options.defaultNull && value === undefined) return null;
      return output;
    },
    [fieldSpecSparseRead](input: TInput, key: string) {
      try {
        return options.readValue(options.selectSource(input, key));
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
        mode: nullableMode(options.mode),
        readValue: options.readNullableValue
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
        readValue: options.readNullableValue,
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
import { isRecord } from '../utils/normalizeHelpers';
