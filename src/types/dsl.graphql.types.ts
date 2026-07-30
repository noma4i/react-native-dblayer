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
    TNode,
    const TOptions extends GraphqlActionOptions<
      TypedDocumentData<TDocument>,
      TypedDocumentVariables<TDocument>,
      TypedMutationInput<TypedDocumentVariables<TDocument>>,
      TResultKey,
      TNode
    >
  >(
    document: TDocument,
    options: TOptions
  ): GraphqlActionDefinition<
    TypedDocumentData<TDocument>,
    TypedDocumentVariables<TDocument>,
    TypedMutationInput<TypedDocumentVariables<TDocument>>,
    TResultKey,
    TNode
  > &
    NoInfer<TOptions>;
};
