import { toStr } from '../utils/normalizeHelpers';
import { readObjectField, readSourceKey } from './fieldSpec';
import type { FieldSpec } from './fieldSpec';
import type { InferStoredFields } from './infer';

type SchemaFields<TInput> = Record<string, FieldSpec<TInput, any, any, any>>;

export type DbSchema<TInput, TFields extends SchemaFields<TInput>> = {
  fields: TFields;
  normalize: (input: TInput) => (Partial<InferStoredFields<TFields>> & { id: string }) | null;
};

const normalizeId = (value: unknown): string | null => {
  const id = toStr(value);
  if (!id) return null;
  return id;
};

/** A row source must be a non-null object; guard/rowId/field readers assume object shape. */
const isNormalizableInput = (input: unknown): boolean => typeof input === 'object' && input !== null;

/**
 * Build a row-id resolver by joining normalized own-key reads or selector outputs with `:`.
 *
 * @param parts Own-property keys or functions that read id parts from an input object.
 * @returns A resolver that returns `null` when any key/selector is unreadable or yields an empty part.
 */
export function compositeId(...keys: string[]): (input: unknown) => string | null;
export function compositeId<TInput>(...selectors: Array<(input: TInput) => unknown>): (input: TInput) => string | null;
export function compositeId<TInput>(...parts: Array<string | ((input: TInput) => unknown)>): (input: TInput) => string | null {
  return input => {
    if (!parts.length) return null;

    const normalizedParts: string[] = [];

    for (const partReader of parts) {
      let value: unknown;
      try {
        value = typeof partReader === 'string' ? readSourceKey(input, partReader) : partReader(input);
      } catch {
        return null;
      }

      const part = normalizeId(value);
      if (part === null) return null;
      normalizedParts.push(part);
    }

    return normalizedParts.join(':');
  };
}

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
