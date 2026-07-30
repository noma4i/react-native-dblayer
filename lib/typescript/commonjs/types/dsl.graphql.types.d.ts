import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { ActionContext, GraphqlActionDefinition, GraphqlActionOptions, GraphqlConnectionDefinition, GraphqlConnectionNode, GraphqlConnectionOptions, GraphqlListDefinition, GraphqlListOptions, GraphqlLiveDefinition, GraphqlLiveOptions, GraphqlSingleDefinition, GraphqlSingleOptions, TypedDocumentData, TypedDocumentVariables } from './dsl.modelFacade.types';
type ActionOptionsWithoutVariables<TData, TVariables, TInput, TResultKey extends keyof TData & string, TNode> = GraphqlActionOptions<TData, TVariables, TInput, TResultKey, TNode> extends infer TOptions ? TOptions extends unknown ? Omit<TOptions, 'variables'> : never : never;
export type GraphqlDsl = {
    live<TData, TVariables>(document: TypedDocumentNode<TData, TVariables>, options: GraphqlLiveOptions<TData>): GraphqlLiveDefinition<TData, TVariables>;
    single<TDocument extends TypedDocumentNode<any, any>, TParams, TNode>(document: TDocument, options: GraphqlSingleOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode>): GraphqlSingleDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode>;
    connection<TDocument extends TypedDocumentNode<any, any>, TParams, TConnection extends {
        nodes?: ReadonlyArray<unknown> | null;
        edges?: ReadonlyArray<({
            node?: unknown;
        } & Record<string, unknown>) | null | undefined> | null;
        pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
            hasPreviousPage?: boolean;
            startCursor?: string | null;
        } | null;
    }, TNode = GraphqlConnectionNode<TConnection>, TMapped = TNode>(document: TDocument, options: GraphqlConnectionOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TConnection, TNode, TMapped>): GraphqlConnectionDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TConnection, TNode, TMapped>;
    list<TDocument extends TypedDocumentNode<any, any>, TParams, TNode, TMapped = TNode>(document: TDocument, options: GraphqlListOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode, TMapped>): GraphqlListDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode, TMapped>;
    action<TDocument extends TypedDocumentNode<any, any>, TInput, TResultKey extends keyof TypedDocumentData<TDocument> & string, TNode, const TRest extends ActionOptionsWithoutVariables<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TInput, TResultKey, TNode>>(document: TDocument, options: {
        variables(input: TInput, context: ActionContext): TypedDocumentVariables<TDocument>;
    } & TRest): GraphqlActionDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TInput, TResultKey, TNode> & {
        variables(input: TInput, context: ActionContext): TypedDocumentVariables<TDocument>;
    } & NoInfer<TRest>;
};
export {};
//# sourceMappingURL=dsl.graphql.types.d.ts.map