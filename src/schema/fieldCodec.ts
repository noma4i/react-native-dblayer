import type { FieldCodec, FieldValueReader } from '../types';

/** Create one typed conversion boundary for a field kind. */
export const defineFieldCodec = <TOut>(read: FieldValueReader<TOut>): FieldCodec<TOut> => ({ read });

const readString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const readNumber = (value: unknown): number | undefined => {
  const numberValue = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isFinite(numberValue)) return undefined;
  const finiteNumber = numberValue as number;
  return Object.is(finiteNumber, -0) ? 0 : finiteNumber;
};

const readInteger = (value: unknown): number | undefined => {
  const numberValue = readNumber(value);
  return Number.isSafeInteger(numberValue) ? numberValue : undefined;
};

const readDate = (value: unknown): string | undefined => {
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? undefined : value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (Number.isFinite(value)) return new Date(value as number).toISOString();
  return undefined;
};

const booleanValues = new Map<unknown, boolean>([
  [true, true],
  [false, false],
  ['true', true],
  ['false', false]
]);

const readBoolean = (value: unknown): boolean | undefined => booleanValues.get(value);

const readId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return id === '' ? undefined : id;
};

/** Canonical codecs used by scalar field builders and internal field-aware reads. */
export const scalarFieldCodecs = {
  str: { read: readString },
  num: { read: readNumber },
  int: { read: readInteger },
  date: { read: readDate },
  bool: { read: readBoolean },
  id: { read: readId }
};
