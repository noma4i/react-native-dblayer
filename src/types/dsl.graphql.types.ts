import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type {
  GraphqlActionDefinition,
  GraphqlActionOptions,
  GraphqlConnectionDefinition,
  GraphqlConnectionOptions,
  TypedDocumentData,
  TypedDocumentVariables,
  TypedMutationInput
} from './dsl.modelFacade.types';

export type GraphqlDsl = {
  connection<TDocument extends TypedDocumentNode<any, any>, TParams>(
    document: TDocument,
    options: GraphqlConnectionOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams>
  ): GraphqlConnectionDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams>;
  action<
    TDocument extends TypedDocumentNode<any, any>,
    TResultKey extends keyof TypedDocumentData<TDocument> & string,
    TNode
  >(
    document: TDocument,
    options: GraphqlActionOptions<
      TypedDocumentData<TDocument>,
      TypedDocumentVariables<TDocument>,
      TypedMutationInput<TypedDocumentVariables<TDocument>>,
      TResultKey,
      TNode
    >
  ): GraphqlActionDefinition<
    TypedDocumentData<TDocument>,
    TypedDocumentVariables<TDocument>,
    TypedMutationInput<TypedDocumentVariables<TDocument>>,
    TResultKey,
    TNode
  >;
};
