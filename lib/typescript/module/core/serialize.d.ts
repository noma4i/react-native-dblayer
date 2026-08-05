import type { CacheNamespace } from '../types/core.persistenceInternals.types';
/** Locale-independent string comparator (codepoint order) shared by every deterministic ordering path: serialization keys and read tie-breaks. */
export declare const compareCodepoints: (left: string, right: string) => number;
/**
 * Serialize a value with stable object-key ordering; total and injective for scalar/temporal scope-key values.
 * @remarks Injective across every JSON-representable value this layer carries (null/undefined, number incl. NaN, bigint, string, boolean, Date, array, plain and other objects). JavaScript `Symbol` values are NOT distinguishable from one another and must not be used as ids or scope-key values (GraphQL scalars never produce them).
 */
export declare const stableSerialize: (value: unknown) => string;
/** Identity-preserving sibling of stableSerialize: plain data serializes structurally, functions and exotic objects get stable per-identity tokens. */
export declare const semanticValue: (value: unknown) => string;
/** Canonical injective composite-key builder: every UTF-16 segment carries its own length prefix. */
export declare const compositeKey: (...parts: ReadonlyArray<string>) => string;
/** Parse a canonical composite key, returning undefined for malformed or truncated input. */
export declare const parseCompositeKey: (key: string) => string[] | undefined;
/** Decode the first segment of a canonical composite key. */
export declare const firstCompositeKeyPart: (key: string) => string;
/** Build one CACHE storage key from a static prefix, a cache namespace, and injective variable segments. Durable keys (`ops`, `quarantine`) are not expressible here by type. */
export declare const compositeStorageKey: (prefix: string, namespace: CacheNamespace, ...parts: ReadonlyArray<string>) => string;
//# sourceMappingURL=serialize.d.ts.map