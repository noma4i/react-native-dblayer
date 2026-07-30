import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { RelationDecl } from './core.relations.types';
import type { DbReadOptions, DbWhere, LoadingState } from './db.types';
import type { ClientSort } from './dsl.ordering.types';
import type { DbShape } from './schema.shape.types';
import type { AnyFields, InferBuildInput, InferStoredFields } from './schema.infer.types';
import type { ModelCore, ScopeHandle } from './dsl.model.types';
export type TypedDocumentData<TDocument> = TDocument extends TypedDocumentNode<infer TData, any> ? TData : never;
export type TypedDocumentVariables<TDocument> = TDocument extends TypedDocumentNode<any, infer TVariables> ? TVariables : never;
export type TypedMutationInput<TVariables> = TVariables extends {
    input: infer TInput;
} ? TInput : TVariables;
export type ModelStoredValue<TShape extends DbShape<any, AnyFields>> = TShape extends DbShape<any, infer TFields> ? InferStoredFields<TFields> : never;
export type ModelBuildInput<TShape extends DbShape<any, AnyFields>> = TShape extends DbShape<any, infer TFields> ? InferBuildInput<TFields> : never;
export type FacadeRuntimeModel<TStored extends {
    id: string;
    updatedAt?: string | null;
}, TInput> = ModelCore<TStored, TInput> & {
    scopes: Record<string, ScopeHandle<TStored, Record<string, unknown>, TInput>>;
};
export type RelationOptions<TStored> = {
    pageSize?: number;
    renderKeys?: readonly (keyof TStored & string)[];
    require?: readonly (keyof TStored & string)[];
    keepPrevious?: boolean;
    enabled?: boolean;
    loadMoreDebounceMs?: number;
};
export type RelationResult<TData> = {
    data: TData;
    loadingState: LoadingState;
    error: Error | null;
    hasMore: boolean;
    loadMore(): void;
    refresh(): Promise<void>;
};
export type Relation<TStored, TData = TStored[]> = {
    read(): TData;
    use(options?: RelationOptions<TStored>): RelationResult<TData>;
    count(): number;
    useCount(): number;
    invalidate(): void;
    issueSequence(field: keyof TStored & string): number;
};
export type GraphqlConnectionOptions<TData, TVariables, TParams> = {
    variables(params: TParams): TVariables;
    connection(data: TData): {
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
    } | null | undefined;
    required?: readonly (keyof TParams & string)[];
    staleTime?: number | string;
    resumeStaleTime?: number | null;
    emptyStaleTime?: number | string;
    refetchOnMount?: boolean;
    maxPages?: number;
    direction?: 'forward' | 'backward';
    cursorVar?: string;
};
export type GraphqlConnectionDefinition<TData, TVariables, TParams> = GraphqlConnectionOptions<TData, TVariables, TParams> & {
    type: 'connection';
    document: TypedDocumentNode<TData, TVariables>;
};
export type ActionKind = 'insert' | 'update' | 'destroy' | 'custom';
export type ActionMode = 'request' | 'durable' | 'poll';
export type ActionContext = {
    tempId: string | null;
    operationId: string;
};
export type OptimisticContext = {
    tempId: string;
    operationId: string;
};
export type GraphqlActionOptions<TData, TVariables, TInput, TResultKey extends keyof TData & string, TNode> = {
    result: TResultKey;
    variables(input: TInput, context: ActionContext): TVariables;
    kind: ActionKind;
    mode?: ActionMode;
    optimistic?: {
        build(input: TInput, context: OptimisticContext): Record<string, unknown> & {
            id: string;
        };
        select(data: TData): TNode | null | undefined;
        existingTempId?(input: TInput): string | null;
        failure?: 'keep' | 'rollback';
        onFailurePatch?(input: TInput): Record<string, unknown>;
        onRetryPatch?(input: TInput): Record<string, unknown>;
        correlate?: {
            fields: readonly string[];
            match?: (candidate: Record<string, unknown>, incoming: Record<string, unknown>) => boolean;
            createdAtWindowMs?: number;
        };
    };
    dedupe?: false | {
        key(input: TInput): string | null;
    };
    once?: boolean;
    invalidate?(context: {
        input: TInput;
        data: TData;
    }): void;
    track?(context: {
        input: TInput;
        data: TData;
    }): void;
};
export type GraphqlActionDefinition<TData, TVariables, TInput, TResultKey extends keyof TData & string, TNode> = GraphqlActionOptions<TData, TVariables, TInput, TResultKey, TNode> & {
    type: 'action';
    document: TypedDocumentNode<TData, TVariables>;
};
export type RelationSpec<TStored, TRemote = GraphqlConnectionDefinition<any, any, any>> = {
    by?: Record<string, keyof TStored & string>;
    member?: (row: TStored) => boolean;
    sort?: ClientSort<TStored> | 'server-order';
    retention?: {
        maxRows: number;
    };
    remote?: TRemote;
};
export type SideloadEdge = {
    model: {
        key: string;
    };
    select(input: unknown): unknown | readonly unknown[] | null | undefined;
};
export type ModelFacadeConfig<TShape extends DbShape<any, AnyFields>, TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>>, TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>, TAssociations extends Record<string, RelationDecl>, TStatics extends Record<string, unknown>> = {
    schema: TShape;
    associations?: () => TAssociations;
    relations?: TRelations;
    actions?: TActions;
    sideloads?: () => Record<string, SideloadEdge>;
    defaultOrder?: DbReadOptions<ModelStoredValue<TShape>>['orderBy'];
    rowId?: (input: unknown) => string;
    guard?: (input: unknown) => boolean;
    gc?: 'exempt';
    maintenance?: {
        dropIdleScopesAfterMs?: number;
        dropTempRowsAfterMs?: number;
        protectTempRows?: () => ReadonlySet<string> | readonly string[];
        maxRowsPerScope?: Array<{
            scopeField: keyof ModelStoredValue<TShape> & string;
            limit: number;
            compare: (left: ModelStoredValue<TShape>, right: ModelStoredValue<TShape>) => number;
            protect?: () => (row: ModelStoredValue<TShape>) => boolean;
        }>;
    };
    write?: {
        groups?: Array<{
            fields: readonly (keyof ModelStoredValue<TShape> & string)[];
            policy: import('./core.writePolicies.types').WritePolicy | readonly import('./core.writePolicies.types').WritePolicy[];
        }>;
    };
    statics?: (model: ModelFacadeBase<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions>) => TStatics;
};
type RelationParamsFromBy<TStored, TBy> = TBy extends Record<string, keyof TStored & string> ? {
    [K in keyof TBy]: TBy[K] extends keyof TStored ? TStored[TBy[K]] : never;
} : Record<string, never>;
export type RelationParams<TStored, TDefinition> = TDefinition extends {
    remote: GraphqlConnectionDefinition<any, any, infer TParams>;
} ? TParams : TDefinition extends {
    by: infer TBy;
} ? RelationParamsFromBy<TStored, TBy> : Record<string, never>;
export type ActionInput<TDefinition> = TDefinition extends GraphqlActionDefinition<any, any, infer TInput, any, any> ? TInput : never;
export type ActionPayload<TDefinition> = TDefinition extends GraphqlActionDefinition<infer TData, any, any, infer TResultKey, any> ? NonNullable<TData[TResultKey]> : never;
export type ModelActionHook<TInput, TResult> = {
    run(input: TInput): Promise<TResult | null>;
    isPending: boolean;
    error: Error | null;
};
export type ModelAction<TInput, TResult> = {
    run(input: TInput): Promise<TResult | null>;
    retry(tempId: string): Promise<TResult | null>;
    discard(tempId: string): void;
    use(): ModelActionHook<TInput, TResult>;
};
export type RowOperationState<TStored> = {
    pending: boolean;
    failed: boolean;
    unsyncedChanges: Partial<TStored> | undefined;
};
export type RowOperation<TStored> = {
    read(): RowOperationState<TStored>;
    use(): RowOperationState<TStored>;
};
export type ModelRelationMethods<TStored, TRelations extends Record<string, RelationSpec<TStored, any>>> = {
    [K in keyof TRelations]: (params: RelationParams<TStored, TRelations[K]>) => Relation<TStored>;
};
export type ModelActionMethods<TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>> = {
    [K in keyof TActions]: ModelAction<ActionInput<TActions[K]>, ActionPayload<TActions[K]>>;
};
export type ModelFacadeCore<TStored extends {
    id: string;
}, TInput, TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>> = {
    key: string;
    find(id: string | null | undefined): TStored | undefined;
    useFind(id: string | null | undefined, options?: {
        renderKeys?: readonly (keyof TStored & string)[];
        require?: readonly (keyof TStored & string)[];
    }): TStored | undefined;
    where(where: DbWhere<TStored>, options?: DbReadOptions<TStored>): Relation<TStored>;
    byIds(ids: readonly string[] | null | undefined): Relation<TStored>;
    insert(row: TInput): void;
    insertMany(rows: TInput[]): void;
    update(id: string, patch: Partial<TStored>): void;
    updateAll(where: DbWhere<TStored>, patch: Partial<TStored>): number;
    destroy(id: string): void;
    destroyMany(ids: string[]): void;
    destroyAll(where: DbWhere<TStored>): number;
    build(input: TInput): TStored;
    operation(id: string | null | undefined): RowOperation<TStored>;
    actions: ModelActionMethods<TActions>;
};
export type ModelFacadeBase<TStored extends {
    id: string;
}, TInput, TRelations extends Record<string, RelationSpec<TStored, any>>, TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>> = ModelFacadeCore<TStored, TInput, TActions> & ModelRelationMethods<TStored, TRelations>;
export type ModelFacade<TStored extends {
    id: string;
}, TInput, TRelations extends Record<string, RelationSpec<TStored, any>>, TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>, TStatics extends Record<string, unknown>> = ModelFacadeBase<TStored, TInput, TRelations, TActions> & TStatics;
export {};
//# sourceMappingURL=dsl.modelFacade.types.d.ts.map