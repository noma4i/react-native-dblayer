import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { ScopeCoverage } from './core.planes.scopeIndex.types';
import type { ModelRef, RelationDecl } from './core.relations.types';
import type { DbReadOptions, DbWhere, LoadingState } from './db.types';
import type { IngestDecl } from './dsl.ingest.types';
import type { ClientSort } from './dsl.ordering.types';
import type { DbShape } from './schema.shape.types';
import type { AnyFields, InferBuildInput, InferStoredFields } from './schema.infer.types';
import type { ModelCore, ScopeHandle } from './dsl.model.types';
import type { DbSubscriptionEntry } from './subscription.types';
import type { ModelStatusPollerPhase } from './utils.modelStatusPoller.types';

export type TypedDocumentData<TDocument> = TDocument extends TypedDocumentNode<infer TData, any> ? TData : never;
export type TypedDocumentVariables<TDocument> = TDocument extends TypedDocumentNode<any, infer TVariables> ? TVariables : never;
export type TypedMutationInput<TVariables> = TVariables extends { input: infer TInput } ? TInput : TVariables;

export type ModelStoredValue<TShape extends DbShape<any, AnyFields>> = TShape extends DbShape<any, infer TFields> ? InferStoredFields<TFields> : never;
export type ModelBuildInput<TShape extends DbShape<any, AnyFields>> = TShape extends DbShape<infer TInput, infer TFields>
  ? unknown extends TInput
    ? InferBuildInput<TFields>
    : TInput
  : never;

export type FacadeRuntimeModel<TStored extends { id: string; updatedAt?: string | null }, TInput> = ModelCore<TStored, TInput> & {
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
  isFetchingMore: boolean;
  isPreviousData: boolean;
  loadMore(): void;
  refresh(): Promise<void>;
};

export type Relation<TStored, TData = TStored[], TInput = TStored> = {
  read(): TData;
  fetch(): Promise<void>;
  seed(rows: TInput[]): void;
  use(options?: RelationOptions<TStored>): RelationResult<TData>;
  count(): number;
  useCount(): number;
  invalidate(): void;
  issueSequence(field: keyof TStored & string): number;
};

export type GraphqlConnectionNode<TConnection> = NonNullable<TConnection> extends {
  nodes?: ReadonlyArray<infer TNode> | null;
}
  ? NonNullable<TNode>
  : NonNullable<TConnection> extends {
        edges?: ReadonlyArray<infer TEdge> | null;
      }
    ? NonNullable<TEdge> extends { node?: infer TNode }
      ? NonNullable<TNode>
      : never
    : never;

export type GraphqlConnectionOptions<TData, TVariables, TParams, TConnection, TNode, TMapped> = {
  variables(params: TParams): TVariables;
  connection(data: TData): TConnection | null | undefined;
  map?(node: TNode): TMapped;
  cursor?(data: TData, connection: TConnection): string | null;
  mapCursor?(cursor: string): unknown;
  coverage?: ScopeCoverage;
  required?: readonly (keyof TParams & string)[];
  staleTime?: number | string;
  resumeStaleTime?: number | null;
  emptyStaleTime?: number | string;
  refetchOnMount?: boolean;
  maxPages?: number;
  direction?: 'forward' | 'backward';
  cursorVar?: string;
};

export type GraphqlConnectionDefinition<TData, TVariables, TParams, TConnection = any, TNode = any, TMapped = TNode> = GraphqlConnectionOptions<
  TData,
  TVariables,
  TParams,
  TConnection,
  TNode,
  TMapped
> & {
  type: 'connection';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlListOptions<TData, TVariables, TParams, TNode, TMapped> = {
  variables(params: TParams): TVariables;
  select(data: TData): ReadonlyArray<TNode | null | undefined> | null | undefined;
  map?(node: TNode): TMapped;
  required?: readonly (keyof TParams & string)[];
  staleTime?: number | string;
  resumeStaleTime?: number | null;
  emptyStaleTime?: number | string;
  refetchOnMount?: boolean;
};

export type GraphqlListDefinition<TData, TVariables, TParams, TNode, TMapped = TNode> = GraphqlListOptions<
  TData,
  TVariables,
  TParams,
  TNode,
  TMapped
> & {
  type: 'list';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlSingleOptions<TData, TVariables, TParams, TNode> = {
  variables(params: TParams): TVariables;
  select(data: TData): TNode | null | undefined;
  required?: readonly (keyof TParams & string)[];
  staleTime?: number | string;
  resumeStaleTime?: number | null;
  emptyStaleTime?: number | string;
  refetchOnMount?: boolean;
};

export type GraphqlSingleDefinition<TData, TVariables, TParams, TNode> = GraphqlSingleOptions<TData, TVariables, TParams, TNode> & {
  type: 'single';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlLivePayload<TData> = TData[keyof TData];

export type GraphqlLiveOptions<TData> = {
  handler(payload: GraphqlLivePayload<TData>): IngestDecl | null;
  debounce?: DbSubscriptionEntry<GraphqlLivePayload<TData>>['debounce'];
};

export type GraphqlLiveDefinition<TData, TVariables> = GraphqlLiveOptions<TData> & {
  type: 'live';
  document: TypedDocumentNode<TData, TVariables>;
};

export type ActionKind = 'insert' | 'update' | 'destroy' | 'custom';
export type ActionMode = 'request' | 'durable' | 'poll';
export type ActionContext = { tempId: string | null; operationId: string };
export type OptimisticContext = { tempId: string; operationId: string };

type GraphqlActionBase<TData, TVariables, TInput, TResultKey extends keyof TData & string> = {
  result: TResultKey;
  variables(input: TInput, context: ActionContext): TVariables;
  dedupe?: false | { key(input: TInput): string | null };
  once?: boolean;
  before?(input: TInput, context: ActionContext): void;
  after?(context: { input: TInput; data: TData }): void;
  error?(error: Error, context: ActionContext & { input: TInput }): void;
  invalidate?(context: { input: TInput; data: TData }): void;
  track?(context: { input: TInput; data: TData }): void;
};

type InsertAction<TData, TInput, TNode> = {
  kind: 'insert';
  select(data: TData): TNode | null | undefined;
  optimistic?: {
    build(input: TInput, context: OptimisticContext): Record<string, unknown> & { id: string };
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
};

type UpdateAction<TData, TInput, TNode> = {
  kind: 'update';
  id(input: TInput): unknown;
  select(data: TData): TNode | null | undefined;
  optimistic?: {
    patch(input: TInput): Record<string, unknown>;
  };
};

type DestroyAction<TInput> = {
  kind: 'destroy';
  id(input: TInput): unknown;
  optimistic?: boolean;
};

type CustomAction<TData, TNode> = {
  kind: 'custom';
  select?(data: TData): TNode | null | undefined;
};

type RequestMode = {
  mode?: 'request';
};

type DurableMode<TInput> = {
  mode: 'durable';
  resume(entry: { operationId: string; tempId: string; input: TInput }): Promise<'continue' | 'orphaned'>;
};

type PollMode<TData> = {
  mode: 'poll';
  poll: {
    intervalMs: number;
    maxAttempts: number;
    classify?(data: TData): 'ready' | 'failed' | null;
  };
};

export type GraphqlActionOptions<TData, TVariables, TInput, TResultKey extends keyof TData & string, TNode> = GraphqlActionBase<
  TData,
  TVariables,
  TInput,
  TResultKey
> &
  (
    | (InsertAction<TData, TInput, TNode> & (RequestMode | DurableMode<TInput>))
    | (UpdateAction<TData, TInput, TNode> & (RequestMode | PollMode<TData>))
    | (DestroyAction<TInput> & RequestMode)
    | (CustomAction<TData, TNode> & RequestMode)
  );

export type GraphqlActionDefinition<TData, TVariables, TInput, TResultKey extends keyof TData & string, TNode> = GraphqlActionOptions<
  TData,
  TVariables,
  TInput,
  TResultKey,
  TNode
> & {
  type: 'action';
  document: TypedDocumentNode<TData, TVariables>;
};

export type RelationSpec<
  TStored,
  TRemote = GraphqlConnectionDefinition<any, any, any> | GraphqlListDefinition<any, any, any, any> | GraphqlSingleDefinition<any, any, any, any>
> = {
  by?: Record<string, keyof TStored & string>;
  member?: (row: TStored) => boolean;
  sort?: ClientSort<TStored> | 'server-order';
  retention?: { maxRows: number };
  remote?: TRemote;
};

export type SideloadEdge<TInput = unknown> = {
  model: { key: string } | ModelRef<unknown>;
  select(input: TInput): unknown | readonly unknown[] | null | undefined;
};

export type ModelFacadeConfig<
  TShape extends DbShape<any, AnyFields>,
  TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>>,
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>,
  TEvents extends Record<string, { type: 'live' }>,
  TAssociations extends Record<string, RelationDecl<unknown>>,
  TStatics extends Record<string, unknown>
> = {
  schema: TShape;
  associations?: () => TAssociations;
  relations?: TRelations;
  actions?:
    | TActions
    | ((
        model: ModelFacadeCore<ModelStoredValue<TShape>, ModelBuildInput<TShape>, Record<string, never>, Record<string, never>> &
          ModelRelationMethods<ModelStoredValue<TShape>, TRelations, ModelBuildInput<TShape>>
      ) => TActions);
  events?: TEvents;
  sideloads?: () => Record<string, SideloadEdge<ModelBuildInput<TShape>>>;
  defaultOrder?: DbReadOptions<ModelStoredValue<TShape>>['orderBy'];
  rowId?: (input: ModelBuildInput<TShape>) => unknown;
  guard?: (input: ModelBuildInput<TShape>) => boolean;
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
  statics?: (model: ModelFacadeBase<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations>) => TStatics;
};

type RelationParamsFromBy<TStored, TBy> = TBy extends Record<string, keyof TStored & string>
  ? { [K in keyof TBy]: TBy[K] extends keyof TStored ? TStored[TBy[K]] : never }
  : Record<string, never>;

type RelationRemoteParams<TStored, TDefinition, TParams> = TDefinition extends { by: infer TBy } ? TParams & RelationParamsFromBy<TStored, TBy> : TParams;

export type RelationParams<TStored, TDefinition> = TDefinition extends {
  remote: GraphqlConnectionDefinition<any, any, infer TParams>;
}
  ? RelationRemoteParams<TStored, TDefinition, TParams>
  : TDefinition extends { remote: GraphqlListDefinition<any, any, infer TParams, any> }
    ? RelationRemoteParams<TStored, TDefinition, TParams>
  : TDefinition extends { remote: GraphqlSingleDefinition<any, any, infer TParams, any> }
    ? RelationRemoteParams<TStored, TDefinition, TParams>
  : TDefinition extends { by: infer TBy }
    ? RelationParamsFromBy<TStored, TBy>
    : Record<string, never>;

export type ActionInput<TDefinition> = TDefinition extends GraphqlActionDefinition<any, any, infer TInput, any, any> ? TInput : never;
export type ActionPayload<TDefinition> = TDefinition extends GraphqlActionDefinition<infer TData, any, any, infer TResultKey, any>
  ? NonNullable<TData[TResultKey]>
  : never;

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

export type DurableModelAction<TInput> = {
  run(input: TInput): { operationId: string; tempId: string };
  complete(operationId: string, serverNode: unknown): void;
  fail(operationId: string, error: Error): void;
  retry(operationId: string): Promise<'continue' | 'orphaned' | null>;
  discard(operationId: string): void;
};

export type PollModelAction<TInput> = {
  run(input: TInput): Promise<void>;
  use(input: TInput | null): ModelStatusPollerPhase & { refresh(): Promise<void> };
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

export type ModelRelationMethods<TStored, TRelations extends Record<string, RelationSpec<TStored, any>>, TInput = TStored> = {
  [K in keyof TRelations]: (
    params: RelationParams<TStored, TRelations[K]> | null
  ) => Relation<TStored, TRelations[K] extends { remote: GraphqlSingleDefinition<any, any, any, any> } ? TStored | undefined : TStored[], TInput>;
};

export type AssociationStored<TDefinition> = TDefinition extends RelationDecl<infer TStored> ? TStored : never;
export type AssociationData<TDefinition> = TDefinition extends { kind: 'belongsTo' | 'hasOne' }
  ? AssociationStored<TDefinition> | undefined
  : AssociationStored<TDefinition>[];
export type ModelAssociationMethods<TAssociations extends Record<string, RelationDecl<unknown>>> = {
  [K in keyof TAssociations]: (id: string | null | undefined) => Relation<AssociationStored<TAssociations[K]>, AssociationData<TAssociations[K]>>;
};

export type ModelActionMethods<TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>> = {
  [K in keyof TActions]: TActions[K] extends { mode: 'durable' }
    ? DurableModelAction<ActionInput<TActions[K]>>
    : TActions[K] extends { mode: 'poll' }
      ? PollModelAction<ActionInput<TActions[K]>>
      : ModelAction<ActionInput<TActions[K]>, ActionPayload<TActions[K]>>;
};

export type ModelEventHandle<TEvents extends Record<string, { type: 'live' }>> = {
  entries: DbSubscriptionEntry[];
  apply<K extends keyof TEvents & string>(key: K, payload: TEvents[K] extends { handler(payload: infer TPayload): IngestDecl | null } ? TPayload : never): void;
};

export type ModelFacadeCore<
  TStored extends { id: string },
  TInput,
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>,
  TEvents extends Record<string, { type: 'live' }>
> = {
  key: string;
  find(id: string | null | undefined): TStored | undefined;
  useFind(
    id: string | null | undefined,
    options?: { renderKeys?: readonly (keyof TStored & string)[]; require?: readonly (keyof TStored & string)[] }
  ): TStored | undefined;
  where(where: DbWhere<TStored>, options?: DbReadOptions<TStored>): Relation<TStored, TStored[], TInput>;
  byIds(ids: readonly string[] | null | undefined): Relation<TStored, TStored[], TInput>;
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
  events: ModelEventHandle<TEvents>;
};

export type ModelFacadeBase<
  TStored extends { id: string },
  TInput,
  TRelations extends Record<string, RelationSpec<TStored, any>>,
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>,
  TEvents extends Record<string, { type: 'live' }>,
  TAssociations extends Record<string, RelationDecl<unknown>>
> = ModelFacadeCore<TStored, TInput, TActions, TEvents> & ModelRelationMethods<TStored, TRelations, TInput> & ModelAssociationMethods<TAssociations>;

export type ModelFacade<
  TStored extends { id: string },
  TInput,
  TRelations extends Record<string, RelationSpec<TStored, any>>,
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>,
  TEvents extends Record<string, { type: 'live' }>,
  TAssociations extends Record<string, RelationDecl<unknown>>,
  TStatics extends Record<string, unknown>
> = ModelFacadeBase<TStored, TInput, TRelations, TActions, TEvents, TAssociations> & TStatics;
