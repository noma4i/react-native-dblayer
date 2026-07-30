"use strict";

/** Typed GraphQL declarations for model relations and actions. */
export const gql = {
  connection: (document, options) => ({
    type: 'connection',
    document,
    ...options
  }),
  action: (document, options) => ({
    type: 'action',
    document,
    mode: 'request',
    ...options
  })
};
//# sourceMappingURL=graphql.js.map