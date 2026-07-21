/** Locale-independent string comparator (codepoint order) shared by every deterministic ordering path: serialization keys and read tie-breaks. */
export declare const compareCodepoints: (left: string, right: string) => number;
/**
 * Serialize a value with stable object-key ordering; total and injective for scalar/temporal scope-key values.
 * @remarks Injective across every JSON-representable value this layer carries (null/undefined, number incl. NaN, bigint, string, boolean, Date, array, plain and other objects). JavaScript `Symbol` values are NOT distinguishable from one another and must not be used as ids or scope-key values (GraphQL scalars never produce them).
 */
export declare const stableSerialize: (value: unknown) => string;
//# sourceMappingURL=serialize.d.ts.map