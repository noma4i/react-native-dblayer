import type { GraphqlDsl } from '../types';

/** Typed GraphQL declarations for model relations and actions. */
export const gql: GraphqlDsl = {
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
