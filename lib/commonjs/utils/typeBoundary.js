"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.toQueryValue = exports.castNodes = exports.castNode = void 0;
/** Cast unknown connection nodes at the package boundary. */
const castNodes = nodes => nodes;
/** Cast an unknown node at the package boundary. */
exports.castNodes = castNodes;
const castNode = node => node;
/** Cast an unknown value for TanStack DB query predicates. */
exports.castNode = castNode;
const toQueryValue = value => value;
exports.toQueryValue = toQueryValue;
//# sourceMappingURL=typeBoundary.js.map