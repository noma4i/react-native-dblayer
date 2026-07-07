import { toStr } from '../utils/normalizeHelpers';
import type { FieldSpec } from './fieldSpec';
import type { InferStoredFields } from './infer';

type SchemaFields<TInput> = Record<string, FieldSpec<TInput, any, any>>;

export type DbSchema<TInput, TFields extends SchemaFields<TInput>> = {
  fields: TFields;
  normalize: (input: TInput) => (Partial<InferStoredFields<TFields>> & { id: string }) | null;
};

const normalizeId = (value: unknown): string | null => {
  const id = toStr(value);
  if (!id) return null;
  return id;
};

export const compositeId =
  <TInput>(...selectors: Array<(input: TInput) => unknown>): ((input: TInput) => string | null) =>
  input => {
    if (!selectors.length) return null;

    const parts: string[] = [];

    for (const selector of selectors) {
      let value: unknown;
      try {
        value = selector(input);
      } catch {
        return null;
      }

      const part = normalizeId(value);
      if (part === null) return null;
      parts.push(part);
    }

    return parts.join(':');
  };

export const createSchema = <TInput, TFields extends SchemaFields<TInput>>(config: {
  fields: TFields;
  rowId?: (input: TInput) => string | null | undefined;
  guard?: (input: TInput) => boolean;
}): DbSchema<TInput, TFields> => ({
  fields: config.fields,
  normalize(input) {
    if (config.guard && !config.guard(input)) return null;

    const id = normalizeId(config.rowId ? config.rowId(input) : (input as any).id);
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
