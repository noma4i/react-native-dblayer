'use strict';

/**
 * Cast unknown connection nodes (e.g. GraphQL response `edges`/`nodes` typed as `unknown[]` by transport
 * boundaries) to `T[]` at the package boundary. A type-only cast - performs no runtime check or copy.
 *
 * @param nodes Untyped node array.
 * @returns The same array, retyped as `T[]`.
 */
export const castNodes = nodes => nodes;
/**
 * Cast an unknown node (e.g. a GraphQL response field typed `unknown` by transport boundaries) to `T` at
 * the package boundary. A type-only cast - performs no runtime check or copy.
 *
 * @param node Untyped node.
 * @returns The same value, retyped as `T`.
 */
export const castNode = node => node;
//# sourceMappingURL=typeBoundary.js.map
