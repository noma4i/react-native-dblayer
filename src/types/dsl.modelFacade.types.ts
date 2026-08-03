import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { ScopeCoverage } from './core.planes.scopeIndex.types';
import type { ModelRef, RelationDecl } from './core.relations.types';
import type { DbReadOptions, DbWhere, LoadingState } from './db.types';
import type { ClientSort } from './dsl.ordering.types';
import type { DbShape } from './schema.shape.types';
import type { AnyFields, InferBuildInput, InferStoredFields } from './schema.infer.types';
import type { ModelCore, ScopeHandle } from './dsl.model.types';
import type { ModelEventLifecycleEntry, ModelEventSubscription } from './subscription.types';
import type { ModelStatusPollerPhase } from './utils.modelStatusPoller.types';
import type { WritePlan } from './dsl.writePlan.types';
import type { GraphqlDsl } from './dsl.graphql.types';
import type { ModelRootPlan, ModelRootUpdate } from './dsl.modelRoot.types';

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

export type ModelConfigurationRelation<TStored, TData> = {
  read(): TData;
  count(): number;
  issueSequence(field: keyof TStored & string): number;
};

export type ModelConfigurationRelationMethods<TStored, TRelations extends Record<string, RelationSpec<TStored, any>>> = {
  [K in keyof TRelations]: (
    params: RelationParams<TStored, TRelations[K]> | null
  ) => ModelConfigurationRelation<
    TStored,
    TRelations[K] extends { remote: GraphqlSingleDefinition<any, any, any, any> } ? TStored | undefined : TStored[]
  >;
};

export type ModelConfigurationOwner<
  TKey extends string,
  TStored extends { id: string },
  TInput,
  TRelations extends Record<string, RelationSpec<TStored, any>> = Record<never, never>
> = {
  readonly key: TKey;
  find(id: string | null | undefined): TStored | undefined;
  where(where: DbWhere<TStored>, options?: DbReadOptions<TStored>): ModelConfigurationRelation<TStored, TStored[]>;
  byIds(ids: readonly string[] | null | undefined): ModelConfigurationRelation<TStored, TStored[]>;
  build(input: TInput): TStored;
  readonly gql: GraphqlDsl<TKey, TInput, TStored>;
} & ModelConfigurationRelationMethods<TStored, TRelations>;

export type RelationOptions<TStored> = {
  pageSize?: number;
  renderKeys?: readonly (keyof TStored & string)[];
  require?: readonly (keyof TStored & string)[];
  keepPrevious?: boolean;
  enabled?: boolean;
  loadMoreDebounceMs?: number;
};

export type ModelWaitOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
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
  refresh(): Promise<void>;
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

export type GraphqlConnectionOptions<TData, TVariables, TParams, TConnection, TNode, TMapped, TOwnerKey extends string = string> = {
  variables(params: TParams): TVariables;
  connection(data: TData): TConnection | null | undefined;
  map?(node: TNode): TMapped;
  write?(context: { data: TData; nodes: readonly TMapped[]; params: TParams }, plan: WritePlan<TOwnerKey>): void;
  cursor?(data: TData, connection: TConnection): string | null;
  mapCursor?(cursor: string): unknown;
  coverage?: ScopeCoverage;
  required?: readonly (keyof TParams & string)[];
  staleTime?: number | string;
  persistenceVersion?: number;
  resumeStaleTime?: number | null;
  emptyStaleTime?: number | string;
  refetchOnMount?: boolean;
  maxPages?: number;
  direction?: 'forward' | 'backward';
  cursorVar?: string;
};

export type GraphqlConnectionDefinition<TData, TVariables, TParams, TConnection = any, TNode = any, TMapped = TNode, TOwnerKey extends string = string> = GraphqlConnectionOptions<
  TData,
  TVariables,
  TParams,
  TConnection,
  TNode,
  TMapped,
  TOwnerKey
> & {
  type: 'connection';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlListOptions<TData, TVariables, TParams, TNode, TMapped, TOwnerKey extends string = string> = {
  variables(params: TParams): TVariables;
  select(data: TData): ReadonlyArray<TNode | null | undefined> | null | undefined;
  map?(node: TNode): TMapped;
  write?(context: { data: TData; nodes: readonly TMapped[]; params: TParams }, plan: WritePlan<TOwnerKey>): void;
  required?: readonly (keyof TParams & string)[];
  staleTime?: number | string;
  persistenceVersion?: number;
  resumeStaleTime?: number | null;
  emptyStaleTime?: number | string;
  refetchOnMount?: boolean;
};

export type GraphqlListDefinition<TData, TVariables, TParams, TNode, TMapped = TNode, TOwnerKey extends string = string> = GraphqlListOptions<
  TData,
  TVariables,
  TParams,
  TNode,
  TMapped,
  TOwnerKey
> & {
  type: 'list';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlSingleOptions<TData, TVariables, TParams, TNode, TOwnerKey extends string = string> = {
  variables(params: TParams): TVariables;
  select(data: TData): TNode | null | undefined;
  write?(context: { data: TData; nodes: readonly TNode[]; params: TParams }, plan: WritePlan<TOwnerKey>): void;
  required?: readonly (keyof TParams & string)[];
  staleTime?: number | string;
  persistenceVersion?: number;
  resumeStaleTime?: number | null;
  emptyStaleTime?: number | string;
  refetchOnMount?: boolean;
};

export type GraphqlSingleDefinition<TData, TVariables, TParams, TNode, TOwnerKey extends string = string> = GraphqlSingleOptions<TData, TVariables, TParams, TNode, TOwnerKey> & {
  type: 'single';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlLivePayload<TData> = TData[keyof TData];

export type GraphqlLiveOptions<
  TData,
  TVariables,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string },
  TOwnerKey extends string = string
> = {
  variables?: TVariables;
  root: ModelRootPlan<{ payload: GraphqlLivePayload<TData> }, TBuildInput, TStored>;
  write?(context: { payload: GraphqlLivePayload<TData> }, plan: WritePlan<TOwnerKey>): void;
  debounce?: ModelEventLifecycleEntry<GraphqlLivePayload<TData>>['debounce'];
};

export type GraphqlLiveDefinition<
  TData,
  TVariables,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string },
  TOwnerKey extends string = string
> = GraphqlLiveOptions<TData, TVariables, TBuildInput, TStored, TOwnerKey> & {
  type: 'live';
  document: TypedDocumentNode<TData, TVariables>;
};

export type ActionMode = 'request' | 'durable' | 'poll';
export type ActionContext = { tempId: string | null; operationId: string };
export type OptimisticContext = { tempId: string; operationId: string };
export type PollActionContext = { sessionKey: string };

export type MutationCorrelate = {
  fields: readonly string[];
  match?(candidate: Record<string, unknown>, incoming: Record<string, unknown>): boolean;
  createdAtWindowMs?: number;
};

type ActionRoot<TData, TInput, TBuildInput, TStored extends { id: string }> = ModelRootPlan<
  { input: TInput; data: TData },
  TBuildInput,
  TStored
>;

type ActionInsertRoot<TData, TInput, TBuildInput, TStored extends { id: string }> = Extract<
  ActionRoot<TData, TInput, TBuildInput, TStored>,
  { insert: unknown }
>;
type ActionUpdateRoot<TData, TInput, TBuildInput, TStored extends { id: string }> = Extract<
  ActionRoot<TData, TInput, TBuildInput, TStored>,
  { update: unknown }
>;
type ActionDestroyRoot<TData, TInput, TBuildInput, TStored extends { id: string }> = Extract<
  ActionRoot<TData, TInput, TBuildInput, TStored>,
  { destroy: unknown }
>;

type OptimisticActionContext<TInput> = {
  input: TInput;
  tempId: string;
  operationId: string;
};

type OptimisticInsertRoot<TInput, TBuildInput, TStored extends { id: string }> = Omit<
  Extract<ModelRootPlan<OptimisticActionContext<TInput>, TBuildInput, TStored>, { insert: unknown }>,
  'insert'
> & {
  insert: {
    select(context: OptimisticActionContext<TInput>): TBuildInput | null;
  };
};
type OptimisticUpdateRoot<TInput, TBuildInput, TStored extends { id: string }> = Omit<
  Extract<ModelRootPlan<OptimisticActionContext<TInput>, TBuildInput, TStored>, { update: unknown }>,
  'update'
> & {
  update: {
    select(context: OptimisticActionContext<TInput>): ModelRootUpdate<TStored> | null;
  };
};
type OptimisticDestroyRoot<TInput, TBuildInput, TStored extends { id: string }> = Omit<
  Extract<ModelRootPlan<OptimisticActionContext<TInput>, TBuildInput, TStored>, { destroy: unknown }>,
  'destroy'
> & {
  destroy: {
    select(context: OptimisticActionContext<TInput>): string | null;
  };
};

type OptimisticInsert<TInput, TBuildInput, TStored extends { id: string }> = {
  root: OptimisticInsertRoot<TInput, TBuildInput, TStored>;
  correlate?: MutationCorrelate;
};

type OptimisticUpdate<TInput, TBuildInput, TStored extends { id: string }> = {
  root: OptimisticUpdateRoot<TInput, TBuildInput, TStored>;
  correlate?: never;
};

type OptimisticDestroy<TInput, TBuildInput, TStored extends { id: string }> = {
  root: OptimisticDestroyRoot<TInput, TBuildInput, TStored>;
  correlate?: never;
};

type GraphqlActionResponse<
  TData,
  TInput,
  TResultKey extends keyof TData & string,
  TBuildInput,
  TStored extends { id: string },
  TOwnerKey extends string,
  TRoot extends ActionRoot<TData, TInput, TBuildInput, TStored> = ActionRoot<TData, TInput, TBuildInput, TStored>
> = {
  result: TResultKey;
  root: TRoot;
  write?(context: { input: TInput; data: TData }, plan: WritePlan<TOwnerKey>): void;
  track?(context: { input: TInput; data: TData }): void;
};

type GraphqlActionRequestBase<
  TVariables,
  TInput
> = {
  mode?: 'request';
  variables(input: TInput, context: ActionContext): TVariables;
  dedupe?: false | { key(input: TInput): string | null };
  once?: boolean;
  before?(input: TInput, context: ActionContext): void;
  error?(error: Error, context: ActionContext & { input: TInput }): void;
};

type GraphqlActionRequestOptimisticOptions<
  TData,
  TInput,
  TResultKey extends keyof TData & string,
  TOwnerKey extends string,
  TBuildInput,
  TStored extends { id: string }
> =
  | (GraphqlActionResponse<TData, TInput, TResultKey, TBuildInput, TStored, TOwnerKey, ActionInsertRoot<TData, TInput, TBuildInput, TStored>> & {
      optimistic: OptimisticInsert<TInput, TBuildInput, TStored>;
    })
  | (GraphqlActionResponse<TData, TInput, TResultKey, TBuildInput, TStored, TOwnerKey, ActionUpdateRoot<TData, TInput, TBuildInput, TStored>> & {
      optimistic: OptimisticUpdate<TInput, TBuildInput, TStored>;
    })
  | (GraphqlActionResponse<TData, TInput, TResultKey, TBuildInput, TStored, TOwnerKey, ActionDestroyRoot<TData, TInput, TBuildInput, TStored>> & {
      optimistic: OptimisticDestroy<TInput, TBuildInput, TStored>;
    });

export type GraphqlActionRequestOptions<
  TData,
  TVariables,
  TInput,
  TResultKey extends keyof TData & string,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string },
  TOptimistic extends boolean = false
> = (TOptimistic extends true
  ? GraphqlActionRequestOptimisticOptions<TData, TInput, TResultKey, TOwnerKey, TBuildInput, TStored>
  : GraphqlActionResponse<TData, TInput, TResultKey, TBuildInput, TStored, TOwnerKey> & { optimistic?: never }) &
  GraphqlActionRequestBase<TVariables, TInput>;

export type GraphqlActionDurableOptions<
  TData,
  TVariables,
  TInput,
  TResultKey extends keyof TData & string,
  TTransportInput,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string }
> = GraphqlActionResponse<
  TData,
  TInput,
  TResultKey,
  TBuildInput,
  TStored,
  TOwnerKey,
  ActionInsertRoot<TData, TInput, TBuildInput, TStored>
> & {
  mode: 'durable';
  variables(input: TInput, transportInput: TTransportInput, context: OptimisticContext): TVariables;
  optimistic: OptimisticInsert<TInput, TBuildInput, TStored>;
  before?(input: TInput, context: OptimisticContext): void;
  error?(error: Error, context: OptimisticContext & { input: TInput }): void;
};

export type GraphqlActionPollOptions<
  TData,
  TVariables,
  TInput,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string }
> = {
  root: ModelRootPlan<TData, TBuildInput, TStored>;
  write?(context: TData, plan: WritePlan<TOwnerKey>): void;
  track?(context: TData): void;
  mode: 'poll';
  variables(input: TInput, context: PollActionContext): TVariables;
  poll: {
    key(input: TInput): string;
    intervalMs: number;
    maxAttempts: number;
    classify?(data: TData): 'ready' | 'failed' | null;
  };
  before?(input: TInput, context: PollActionContext): void;
  error?(error: Error, context: PollActionContext & { input: TInput }): void;
};

export type GraphqlActionRequestDefinition<
  TData,
  TVariables,
  TInput,
  TResultKey extends keyof TData & string,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string },
  TOptimistic extends boolean = false
> = GraphqlActionRequestOptions<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, TOptimistic> & {
  type: 'action';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlActionDurableDefinition<
  TData,
  TVariables,
  TInput,
  TResultKey extends keyof TData & string,
  TTransportInput,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string }
> = GraphqlActionDurableOptions<TData, TVariables, TInput, TResultKey, TTransportInput, TOwnerKey, TBuildInput, TStored> & {
  type: 'action';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlActionPollDefinition<
  TData,
  TVariables,
  TInput,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string }
> = GraphqlActionPollOptions<TData, TVariables, TInput, TOwnerKey, TBuildInput, TStored> & {
  type: 'action';
  document: TypedDocumentNode<TData, TVariables>;
};

export type GraphqlActionOptions<
  TData,
  TVariables,
  TInput,
  TResultKey extends keyof TData & string,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string },
  TTransportInput = never
> =
  | GraphqlActionRequestOptions<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, false>
  | GraphqlActionRequestOptions<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, true>
  | GraphqlActionDurableOptions<TData, TVariables, TInput, TResultKey, TTransportInput, TOwnerKey, TBuildInput, TStored>
  | GraphqlActionPollOptions<TData, TVariables, TInput, TOwnerKey, TBuildInput, TStored>;

export type GraphqlActionDefinition<
  TData,
  TVariables,
  TInput,
  TResultKey extends keyof TData & string,
  TOwnerKey extends string = string,
  TBuildInput = unknown,
  TStored extends { id: string } = { id: string },
  TTransportInput = never
> =
  | GraphqlActionRequestDefinition<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, false>
  | GraphqlActionRequestDefinition<TData, TVariables, TInput, TResultKey, TOwnerKey, TBuildInput, TStored, true>
  | GraphqlActionDurableDefinition<TData, TVariables, TInput, TResultKey, TTransportInput, TOwnerKey, TBuildInput, TStored>
  | GraphqlActionPollDefinition<TData, TVariables, TInput, TOwnerKey, TBuildInput, TStored>;

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
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any>>,
  TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>>,
  TAssociations extends Record<string, RelationDecl<unknown>>,
  TStatics extends Record<string, unknown>,
  TKey extends string = string
> = {
  schema: TShape;
  associations?: () => TAssociations;
  relations?: (owner: ModelConfigurationOwner<TKey, ModelStoredValue<TShape>, ModelBuildInput<TShape>>) => TRelations;
  actions?: (owner: ModelConfigurationOwner<TKey, ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations>) => TActions;
  events?: (owner: ModelConfigurationOwner<TKey, ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations>) => TEvents;
  sideloads?: () => Record<string, SideloadEdge<ModelBuildInput<TShape>>>;
  defaultOrder?: DbReadOptions<ModelStoredValue<TShape>>['orderBy'];
  rowId?: (input: ModelBuildInput<TShape>) => unknown;
  guard?: (input: ModelBuildInput<TShape>) => boolean;
  maintenance?: {
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
  statics?: (model: ModelFacadeBase<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations, TKey>) => TStatics;
};

type RelationParamsFromBy<TStored, TBy> = TBy extends Record<string, keyof TStored & string>
  ? { [K in keyof TBy]: TBy[K] extends keyof TStored ? NonNullable<TStored[TBy[K]]> : never }
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

export type ActionInput<TDefinition> = TDefinition extends GraphqlActionDefinition<any, any, infer TInput, any> ? TInput : never;
export type ActionPayload<TDefinition> = TDefinition extends GraphqlActionRequestDefinition<infer TData, any, any, infer TResultKey, any, any, any, any>
  ? NonNullable<TData[TResultKey]>
  : TDefinition extends GraphqlActionDurableDefinition<infer TData, any, any, infer TResultKey, any, any, any, any>
    ? NonNullable<TData[TResultKey]>
    : never;

export type ModelActionHook<TInput, TResult> = {
  run(input: TInput): Promise<TResult | null>;
  isPending: boolean;
  error: Error | null;
};

export type ModelAction<TInput, TResult, TOptimistic extends boolean = false> = {
  run(input: TInput): Promise<TResult | null>;
  use(): ModelActionHook<TInput, TResult>;
} & (TOptimistic extends true
  ? {
      retry(rowId: string): Promise<TResult | null>;
      discard(rowId: string): void;
    }
  : {});

export type DurableActionHandle<TTransportInput, TResult> = {
  operationId: string;
  tempId: string;
  execute(transportInput: TTransportInput): Promise<TResult | null>;
  cancel(): void;
};

export type OpenDurableAction<TInput, TTransportInput, TResult> = {
  input: TInput;
  handle: DurableActionHandle<TTransportInput, TResult>;
};

export type DurableModelAction<TInput, TTransportInput = never, TResult = unknown> = {
  start(input: TInput): DurableActionHandle<TTransportInput, TResult>;
  resume(operationId: string): DurableActionHandle<TTransportInput, TResult> | undefined;
  open(): OpenDurableAction<TInput, TTransportInput, TResult>[];
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
  [K in keyof TRelations]: {
    (
      params: RelationParams<TStored, TRelations[K]> | null
    ): Relation<TStored, TRelations[K] extends { remote: GraphqlSingleDefinition<any, any, any, any> } ? TStored | undefined : TStored[], TInput>;
    invalidate(): void;
  };
};

export type AssociationStored<TDefinition> = TDefinition extends RelationDecl<infer TStored> ? TStored : never;
export type AssociationData<TDefinition> = TDefinition extends { kind: 'belongsTo' | 'hasOne' }
  ? AssociationStored<TDefinition> | undefined
  : AssociationStored<TDefinition>[];
export type ModelAssociationMethods<TAssociations extends Record<string, RelationDecl<unknown>>> = {
  [K in keyof TAssociations]: (id: string | null | undefined) => Relation<AssociationStored<TAssociations[K]>, AssociationData<TAssociations[K]>>;
};

export type ModelActionMethods<TActions extends Record<string, GraphqlActionDefinition<any, any, any, any>>> = {
  [K in keyof TActions]: TActions[K] extends GraphqlActionRequestDefinition<any, any, infer TInput, any, any, any, any, infer TOptimistic>
    ? ModelAction<TInput, ActionPayload<TActions[K]>, TOptimistic>
    : TActions[K] extends GraphqlActionDurableDefinition<any, any, infer TInput, any, infer TTransportInput, any, any, any>
      ? DurableModelAction<TInput, TTransportInput, ActionPayload<TActions[K]>>
      : TActions[K] extends GraphqlActionPollDefinition<any, any, infer TInput, any, any, any>
        ? PollModelAction<TInput>
        : never;
};

export type ModelEventHandle<TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>>> = {
  [K in keyof TEvents]: TEvents[K] extends GraphqlLiveDefinition<infer TData, any, any, any, any>
    ? ModelEventSubscription<GraphqlLivePayload<TData>>
    : never;
};

export type ModelFacadeCore<
  TStored extends { id: string },
  TInput,
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any>>,
  TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>>,
  TKey extends string = string
> = {
  key: TKey;
  find(id: string | null | undefined): TStored | undefined;
  wait(id: string | null | undefined, options: ModelWaitOptions): Promise<TStored | undefined>;
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
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any>>,
  TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>>,
  TAssociations extends Record<string, RelationDecl<unknown>>,
  TKey extends string = string
> = ModelFacadeCore<TStored, TInput, TActions, TEvents, TKey> & ModelRelationMethods<TStored, TRelations, TInput> & ModelAssociationMethods<TAssociations>;

export type ModelFacade<
  TStored extends { id: string },
  TInput,
  TRelations extends Record<string, RelationSpec<TStored, any>>,
  TActions extends Record<string, GraphqlActionDefinition<any, any, any, any>>,
  TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>>,
  TAssociations extends Record<string, RelationDecl<unknown>>,
  TStatics extends Record<string, unknown>,
  TKey extends string = string
> = ModelFacadeBase<TStored, TInput, TRelations, TActions, TEvents, TAssociations, TKey> & TStatics;
