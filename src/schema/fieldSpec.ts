export type FieldMode = 'required' | 'nullable' | 'optional' | 'optionalNullable';
export type FieldDefault<TOut> = TOut | (() => TOut);

type NullableMode<TMode extends FieldMode> = TMode extends 'optional' | 'optionalNullable' ? 'optionalNullable' : 'nullable';
type OptionalMode<TMode extends FieldMode> = TMode extends 'nullable' | 'optionalNullable' ? 'optionalNullable' : 'optional';

export interface FieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> {
  read: (input: TInput, key: string) => TOut | null | undefined;
  readValue: FieldValueReader<TOut>;
  mode: TMode;
  factoryDefault?: FieldDefault<TOut>;
  nullable: () => FieldSpec<TInput, TOut, NullableMode<TMode>, THasDefault>;
  optional: () => FieldSpec<TInput, TOut, OptionalMode<TMode>, THasDefault>;
  nullDefault: () => FieldSpec<TInput, TOut, 'nullable', THasDefault>;
  default: (value: FieldDefault<TOut>) => FieldSpec<TInput, TOut, TMode, true>;
  from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode, THasDefault>;
}

export interface EmptyDefaultFieldSpec<TInput, TOut, TMode extends FieldMode = 'required', THasDefault extends boolean = false> extends FieldSpec<TInput, TOut, TMode, THasDefault> {
  emptyDefault: () => EmptyDefaultFieldSpec<TInput, TOut, TMode, true>;
}

export type FieldValueReader<TOut> = (value: unknown) => TOut | null | undefined;
export type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;

type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
  mode: TMode;
  selectSource: FieldSourceSelector<TInput>;
  readValue: FieldValueReader<TOut>;
  readNullableValue: FieldValueReader<TOut>;
  defaultNull: boolean;
  factoryDefault?: FieldDefault<TOut>;
};

export const readObjectField = <TInput>(input: TInput, key: string): unknown => {
  if (typeof input !== 'object' || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
};

const nullableMode = <TMode extends FieldMode>(mode: TMode): NullableMode<TMode> => (mode === 'optional' || mode === 'optionalNullable' ? 'optionalNullable' : 'nullable') as NullableMode<TMode>;

const optionalMode = <TMode extends FieldMode>(mode: TMode): OptionalMode<TMode> => (mode === 'nullable' || mode === 'optionalNullable' ? 'optionalNullable' : 'optional') as OptionalMode<TMode>;

export const preserveNull = <TOut>(readValue: FieldValueReader<TOut>): FieldValueReader<TOut> => value => {
  if (value === null) return null;
  return readValue(value);
};

export const createFieldSpec = <TInput, TOut, TMode extends FieldMode, THasDefault extends boolean = false>(
  options: FieldSpecOptions<TInput, TOut, TMode>
): FieldSpec<TInput, TOut, TMode, THasDefault> => {
  const spec: FieldSpec<TInput, TOut, TMode, THasDefault> = {
    mode: options.mode,
    readValue(value) {
      const output = options.readValue(value);
      if (output === undefined && options.defaultNull && value === undefined) return null;
      return output;
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
      })
  };

  if (Object.prototype.hasOwnProperty.call(options, 'factoryDefault')) {
    spec.factoryDefault = options.factoryDefault;
  }

  return spec;
};
