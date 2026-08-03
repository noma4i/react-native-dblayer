import type { GraphqlDsl } from '../types';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';

/** Typed GraphQL declarations for model relations and actions. */
export const createGraphqlDsl = <TOwnerKey extends string, TBuildInput, TStored extends { id: string }>(): GraphqlDsl<TOwnerKey, TBuildInput, TStored> => ({
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
  action: (document: TypedDocumentNode<unknown, never>, options: Record<string, unknown>) =>
    ({
      type: 'action',
      document,
      ...options
    }) as never
});
