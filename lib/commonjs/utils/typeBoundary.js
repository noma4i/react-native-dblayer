'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.castNodes = exports.castNode = void 0;
/**
 * Cast unknown connection nodes (e.g. GraphQL response `edges`/`nodes` typed as `unknown[]` by transport
 * boundaries) to `T[]` at the package boundary. A type-only cast - performs no runtime check or copy.
 *
 * @param nodes Untyped node array.
 * @returns The same array, retyped as `T[]`.
 */
const castNodes = nodes => nodes;
/**
 * Cast an unknown node (e.g. a GraphQL response field typed `unknown` by transport boundaries) to `T` at
 * the package boundary. A type-only cast - performs no runtime check or copy.
 *
 * @param node Untyped node.
 * @returns The same value, retyped as `T`.
 */
exports.castNodes = castNodes;
const castNode = node => node;
exports.castNode = castNode;
//# sourceMappingURL=typeBoundary.js.map
