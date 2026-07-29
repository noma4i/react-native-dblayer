"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.stableSerialize = exports.semanticValue = exports.parseCompositeKey = exports.firstCompositeKeyPart = exports.compositeStorageKey = exports.compositeKey = exports.compareCodepoints = void 0;
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
/** Locale-independent string comparator (codepoint order) shared by every deterministic ordering path: serialization keys and read tie-breaks. */
const compareCodepoints = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/**
 * Serialize a value with stable object-key ordering; total and injective for scalar/temporal scope-key values.
 * @remarks Injective across every JSON-representable value this layer carries (null/undefined, number incl. NaN, bigint, string, boolean, Date, array, plain and other objects). JavaScript `Symbol` values are NOT distinguishable from one another and must not be used as ids or scope-key values (GraphQL scalars never produce them).
 */
exports.compareCodepoints = compareCodepoints;
const stableSerialize = value => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'number') return Number.isNaN(value) ? 'NaN' : String(value);
  if (type === 'bigint') return `${value.toString()}n`;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return `Date(${value.getTime()})`;
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if ((0, _normalizeHelpers.isNonArrayRecord)(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => compareCodepoints(a, b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`).join(',')}}`;
  }
  return `Obj(${JSON.stringify(String(value))})`;
};
exports.stableSerialize = stableSerialize;
const identityTokens = new WeakMap();
let nextIdentityToken = 1;

/** Identity-preserving sibling of stableSerialize: plain data serializes structurally, functions and exotic objects get stable per-identity tokens. */
const semanticValue = value => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') {
    const token = identityTokens.get(value) ?? nextIdentityToken++;
    identityTokens.set(value, token);
    return `function:${token}`;
  }
  if (Array.isArray(value)) return `[${value.map(semanticValue).join(',')}]`;
  if ((0, _normalizeHelpers.isRecord)(value)) {
    const object = value;
    const record = value;
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${semanticValue(record[key])}`).join(',')}}`;
    }
    const token = identityTokens.get(object) ?? nextIdentityToken++;
    identityTokens.set(object, token);
    return `object:${token}`;
  }
  return String(value);
};

/** Canonical injective composite-key builder: every UTF-16 segment carries its own length prefix. */
exports.semanticValue = semanticValue;
const compositeKey = (...parts) => parts.map(part => `${part.length}:${part}`).join('');

/** Parse a canonical composite key, returning undefined for malformed or truncated input. */
exports.compositeKey = compositeKey;
const parseCompositeKey = key => {
  const parts = [];
  let offset = 0;
  while (offset < key.length) {
    const separator = key.indexOf(':', offset);
    const rawLength = separator < 0 ? '' : key.slice(offset, separator);
    if (!/^\d+$/.test(rawLength)) return undefined;
    const length = Number(rawLength);
    const start = separator + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || end > key.length) return undefined;
    parts.push(key.slice(start, end));
    offset = end;
  }
  return parts;
};

/** Decode the first segment of a canonical composite key. */
exports.parseCompositeKey = parseCompositeKey;
const firstCompositeKeyPart = key => {
  const first = parseCompositeKey(key)?.[0];
  if (first === undefined) throw new Error('Invalid composite key');
  return first;
};

/** Build one storage namespace key from a static prefix, a namespace, and injective variable segments. */
exports.firstCompositeKeyPart = firstCompositeKeyPart;
const compositeStorageKey = (prefix, namespace, ...parts) => `${prefix}${namespace}:${compositeKey(...parts)}`;
exports.compositeStorageKey = compositeStorageKey;
//# sourceMappingURL=serialize.js.map