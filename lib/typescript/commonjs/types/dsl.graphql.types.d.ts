import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { GraphqlActionDurableDefinition, GraphqlActionDurableOptions, GraphqlActionRequestDefinition, GraphqlActionRequestOptions, GraphqlConnectionDefinition, GraphqlConnectionNode, GraphqlConnectionOptions, GraphqlListDefinition, GraphqlListOptions, GraphqlLiveDefinition, GraphqlLiveOptions, GraphqlSingleDefinition, GraphqlSingleOptions, TypedDocumentData, TypedDocumentVariables } from './dsl.modelFacade.types';
export type GraphqlDsl<TOwnerKey extends string = string, TBuildInput = unknown, TStored extends {
    id: string;
} = {
    id: string;
}> = {
    live<TData, TVariables>(document: TypedDocumentNode<TData, TVariables>, options: GraphqlLiveOptions<TData, TVariables, TBuildInput, TStored, TOwnerKey>): GraphqlLiveDefinition<TData, TVariables, TBuildInput, TStored, TOwnerKey>;
    single<TDocument extends TypedDocumentNode<any, any>, TParams, TNode>(document: TDocument, options: GraphqlSingleOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode, TOwnerKey>): GraphqlSingleDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode, TOwnerKey>;
    connection<TDocument extends TypedDocumentNode<any, any>, TParams, TConnection extends {
        nodes?: ReadonlyArray<unknown> | null;
        edges?: ReadonlyArray<({
            node?: unknown;
        } & Record<string, unknown>) | null | undefined> | null;
        pageInfo?: {
            hasNextPage?: boolean | null;
            endCursor?: string | null;
            hasPreviousPage?: boolean | null;
            startCursor?: string | null;
        } | null;
    }, TNode = GraphqlConnectionNode<TConnection>, TMapped = TNode>(document: TDocument, options: GraphqlConnectionOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TConnection, TNode, TMapped, TOwnerKey>): GraphqlConnectionDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TConnection, TNode, TMapped, TOwnerKey>;
    list<TDocument extends TypedDocumentNode<any, any>, TParams, TNode, TMapped = TNode>(document: TDocument, options: GraphqlListOptions<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode, TMapped, TOwnerKey>): GraphqlListDefinition<TypedDocumentData<TDocument>, TypedDocumentVariables<TDocument>, TParams, TNode, TMapped, TOwnerKey>;
    action<TData, TVariables, TInput, TTransportInput, TResultKey extends keyof TData & string>(document: TypedDocumentNode<TData, TVariables>, options: GraphqlActionDurableOptions<TData, TVariables, TInput, TResultKey, TTransportInput, TOwnerKey, TBuildInput, TStored>): GraphqlActionDurableDefinition<TData, TVariables, TInput, TResultKey, TTransportInput, TOwnerKey, TBuildInput, TStored>;
    action<TData, TVariables, TInput, TResultKey extends keyof TData & string>(document: TypedDocumentNode<TData, TVariables>, options: GraphqlActionRequestOptions<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, true>): GraphqlActionRequestDefinition<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, true>;
    action<TData, TVariables, TInput, TResultKey extends keyof TData & string>(document: TypedDocumentNode<TData, TVariables>, options: GraphqlActionRequestOptions<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, false>): GraphqlActionRequestDefinition<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, false>;
};
//# sourceMappingURL=dsl.graphql.types.d.ts.map