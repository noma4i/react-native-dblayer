import { isNonArrayRecord } from '../utils/normalizeHelpers';

/** Locale-independent string comparator (codepoint order) shared by every deterministic ordering path: serialization keys and read tie-breaks. */
export const compareCodepoints = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Serialize a value with stable object-key ordering; total and injective for scalar/temporal scope-key values.
 * @remarks Injective across every JSON-representable value this layer carries (null/undefined, number incl. NaN, bigint, string, boolean, Date, array, plain and other objects). JavaScript `Symbol` values are NOT distinguishable from one another and must not be used as ids or scope-key values (GraphQL scalars never produce them).
 */
export const stableSerialize = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'number') return Number.isNaN(value as number) ? 'NaN' : String(value);
  if (type === 'bigint') return `${(value as bigint).toString()}n`;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return `Date(${value.getTime()})`;
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isNonArrayRecord(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => compareCodepoints(a, b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`).join(',')}}`;
  }
  return `Obj(${JSON.stringify(String(value))})`;
};
