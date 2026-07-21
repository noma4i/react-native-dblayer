/**
 * Unwrap a GraphQL connection-style payload into a dense node array: `connection.nodes` with
 * `null`/`undefined` entries removed. Tolerates nullish connections and nullish node lists.
 *
 * @param connection Connection-like object carrying a nullable `nodes` list, or nullish.
 * @returns The non-nullish nodes in order; `[]` when absent.
 */
export declare const fromNodes: <T>(connection: {
    nodes?: ReadonlyArray<T | null | undefined> | null;
} | null | undefined) => T[];
//# sourceMappingURL=connection.d.ts.map