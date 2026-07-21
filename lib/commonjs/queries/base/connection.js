"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.fromNodes = void 0;
/**
 * Unwrap a GraphQL connection-style payload into a dense node array: `connection.nodes` with
 * `null`/`undefined` entries removed. Tolerates nullish connections and nullish node lists.
 *
 * @param connection Connection-like object carrying a nullable `nodes` list, or nullish.
 * @returns The non-nullish nodes in order; `[]` when absent.
 */
const fromNodes = connection => (connection?.nodes ?? []).filter(node => node != null);
exports.fromNodes = fromNodes;
//# sourceMappingURL=connection.js.map