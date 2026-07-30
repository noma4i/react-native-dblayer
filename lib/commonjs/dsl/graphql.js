"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.gql = void 0;
/** Typed GraphQL declarations for model relations and actions. */
const gql = exports.gql = {
  connection: (document, options) => ({
    type: 'connection',
    document,
    ...options
  }),
  action: (document, options) => ({
    type: 'action',
    document,
    ...options
  })
};
//# sourceMappingURL=graphql.js.map