import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type {
  ActionContext,
  GraphqlActionDefinition,
  GraphqlActionOptions,
  GraphqlConnectionDefinition,
  GraphqlConnectionOptions,
  GraphqlLiveDefinition,
  GraphqlLiveOptions,
  GraphqlSingleDefinition,
  GraphqlSingleOptions,
  TypedDocumentData,
  TypedDocumentVariables
} from './dsl.modelFacade.types';

type ActionOptionsWithoutVariables<TData, TVariables, TInput, TResultKey extends keyof TData & string, TNode> = GraphqlActionOptions<
  TData,
  TVariables,
  TInput,
  TResultKey,
  TNode
> extends infer TOptions
  ? TOptions extends unknown
    ? Omit<TOptions, 'variables'>
    : never
  : never;

export type GraphqlDsl = {
  live<TData, TVariables>(
    document: TypedDocumentNode<TData, TVariables>,
    options: GraphqlLiveOptions<TData>
  ): GraphqlLiveDefinition<TData, TVariables>;
  single<TDocument extends TypedDocumentNode<any, any>, TParams, TNode>(
    document: TDocument,
    options: GraphqlSingleOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode>
  ): GraphqlSingleDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode>;
  connection<TDocument extends TypedDocumentNode<any, any>, TParams>(
    document: TDocument,
    options: GraphqlConnectionOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams>
  ): GraphqlConnectionDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams>;
  action<
    TDocument extends TypedDocumentNode<any, any>,
    TInput,
    TResultKey extends keyof TypedDocumentData<TDocument> & string,
    TNode,
    const TRest extends ActionOptionsWithoutVariables<
      TypedDocumentData<TDocument>,
      TypedDocumentVariables<TDocument>,
      TInput,
      TResultKey,
      TNode
    >
  >(
    document: TDocument,
    options: {
      variables(input: TInput, context: ActionContext): TypedDocumentVariables<TDocument>;
    } & TRest
  ): GraphqlActionDefinition<
    TypedDocumentData<TDocument>,
    TypedDocumentVariables<TDocument>,
    TInput,
    TResultKey,
    TNode
  > &
    {
      variables(input: TInput, context: ActionContext): TypedDocumentVariables<TDocument>;
    } &
    NoInfer<TRest>;
};
