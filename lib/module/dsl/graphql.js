"use strict";

/** Typed GraphQL declarations for model relations and actions. */
export const createGraphqlDsl = () => ({
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
//# sourceMappingURL=graphql.js.map