export type FieldMode = 'required' | 'nullable' | 'optional' | 'optionalNullable';

type NullableMode<TMode extends FieldMode> = TMode extends 'optional' | 'optionalNullable' ? 'optionalNullable' : 'nullable';
type OptionalMode<TMode extends FieldMode> = TMode extends 'nullable' | 'optionalNullable' ? 'optionalNullable' : 'optional';

export interface FieldSpec<TInput, TOut, TMode extends FieldMode = 'required'> {
  read: (input: TInput, key: string) => TOut | null | undefined;
  readValue: FieldValueReader<TOut>;
  mode: TMode;
  nullable: () => FieldSpec<TInput, TOut, NullableMode<TMode>>;
  optional: () => FieldSpec<TInput, TOut, OptionalMode<TMode>>;
  nullDefault: () => FieldSpec<TInput, TOut, 'nullable'>;
  from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) => FieldSpec<TNextInput, TOut, TMode>;
}

export type FieldValueReader<TOut> = (value: unknown) => TOut | null | undefined;
export type FieldSourceSelector<TInput> = (input: TInput, key: string) => unknown;

type FieldSpecOptions<TInput, TOut, TMode extends FieldMode> = {
  mode: TMode;
  selectSource: FieldSourceSelector<TInput>;
  readValue: FieldValueReader<TOut>;
  readNullableValue: FieldValueReader<TOut>;
  defaultNull: boolean;
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

export const createFieldSpec = <TInput, TOut, TMode extends FieldMode>(options: FieldSpecOptions<TInput, TOut, TMode>): FieldSpec<TInput, TOut, TMode> => {
  const spec: FieldSpec<TInput, TOut, TMode> = {
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
      return createFieldSpec({
        ...options,
        mode: nullableMode(options.mode),
        readValue: options.readNullableValue
      });
    },
    optional() {
      return createFieldSpec({
        ...options,
        mode: optionalMode(options.mode)
      });
    },
    nullDefault() {
      return createFieldSpec({
        ...options,
        mode: 'nullable',
        readValue: options.readNullableValue,
        defaultNull: true
      });
    },
    from: <TNextInput = TInput>(selector: (input: TNextInput) => unknown) =>
      createFieldSpec<TNextInput, TOut, TMode>({
        mode: options.mode,
        selectSource: input => selector(input),
        readValue: options.readValue,
        readNullableValue: options.readNullableValue,
        defaultNull: options.defaultNull
      })
  };

  return spec;
};
