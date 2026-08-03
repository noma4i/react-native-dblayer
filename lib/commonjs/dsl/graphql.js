"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createGraphqlDsl = void 0;
/** Typed GraphQL declarations for model relations and actions. */
const createGraphqlDsl = () => ({
  live: (document, options) => ({
    type: 'live',
    document,
    ...options
  }),
  single: (document, options) => ({
    type: 'single',
    document,
    ...options
  }),
  list: (document, options) => ({
    type: 'list',
    document,
    ...options
  }),
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
});
exports.createGraphqlDsl = createGraphqlDsl;
//# sourceMappingURL=graphql.js.map