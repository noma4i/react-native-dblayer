/** Locale-independent string comparator (codepoint order) shared by every deterministic ordering path: serialization keys and read tie-breaks. */
export declare const compareCodepoints: (left: string, right: string) => number;
/**
 * Serialize a value with stable object-key ordering; total and injective for scalar/temporal scope-key values.
 * @remarks Injective across every JSON-representable value this layer carries (null/undefined, number incl. NaN, bigint, string, boolean, Date, array, plain and other objects). JavaScript `Symbol` values are NOT distinguishable from one another and must not be used as ids or scope-key values (GraphQL scalars never produce them).
 */
export declare const stableSerialize: (value: unknown) => string;
/** Identity-preserving sibling of stableSerialize: plain data serializes structurally, functions and exotic objects get stable per-identity tokens. */
export declare const semanticValue: (value: unknown) => string;
/** Canonical composite-key builder: joins parts with NUL so segment boundaries survive any content. */
export declare const compositeKey: (...parts: ReadonlyArray<string>) => string;
//# sourceMappingURL=serialize.d.ts.map