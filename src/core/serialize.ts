import { isNonArrayRecord, isRecord } from '../utils/normalizeHelpers';

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

const identityTokens = new WeakMap<object, number>();
let nextIdentityToken = 1;

/** Identity-preserving sibling of stableSerialize: plain data serializes structurally, functions and exotic objects get stable per-identity tokens. */
export const semanticValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') {
    const token = identityTokens.get(value) ?? nextIdentityToken++;
    identityTokens.set(value, token);
    return `function:${token}`;
  }
  if (Array.isArray(value)) return `[${value.map(semanticValue).join(',')}]`;
  if (isRecord(value)) {
    const object = value as object;
    const record = value as Record<string, unknown>;
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return `{${Object.keys(record)
        .sort()
        .map(key => `${JSON.stringify(key)}:${semanticValue(record[key])}`)
        .join(',')}}`;
    }
    const token = identityTokens.get(object) ?? nextIdentityToken++;
    identityTokens.set(object, token);
    return `object:${token}`;
  }
  return String(value);
};

/** Canonical composite-key builder: joins parts with NUL so segment boundaries survive any content. */
export const compositeKey = (...parts: ReadonlyArray<string>): string => parts.join('\0');
