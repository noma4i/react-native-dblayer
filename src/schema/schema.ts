import { isRecord, stringifyNullish } from '../utils/normalizeHelpers';
import { readObjectField } from './fieldSpec';
import type { FieldSpec } from './fieldSpec';
import type { InferStoredFields } from './infer';

type SchemaFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;

export type DbSchema<TInput, TFields extends SchemaFields<TInput>> = {
  fields: TFields;
  normalize: (input: TInput) => (Partial<InferStoredFields<TFields>> & { id: string }) | null;
};

const normalizeId = (value: unknown): string | null => {
  const id = stringifyNullish(value);
  if (!id) return null;
  return id;
};

/** A row source must be a non-null object; guard/rowId/field readers assume object shape. */
const isNormalizableInput = (input: unknown): boolean => isRecord(input);

export const createSchema = <TInput, TFields extends SchemaFields<TInput>>(config: {
  fields: TFields;
  rowId?: (input: TInput) => string | null | undefined;
  guard?: (input: TInput) => boolean;
}): DbSchema<TInput, TFields> => ({
  fields: config.fields,
  normalize(input) {
    if (!isNormalizableInput(input)) return null;
    if (config.guard && !config.guard(input)) return null;

    const id = normalizeId(config.rowId ? config.rowId(input) : readObjectField(input, 'id'));
    if (id === null) return null;

    const output: Record<string, unknown> & { id: string } = { id };

    for (const key of Object.keys(config.fields)) {
      const value = config.fields[key]!.read(input, key);
      if (value !== undefined) {
        output[key] = value;
      }
    }

    return output as Partial<InferStoredFields<TFields>> & { id: string };
  }
});
