import type { DbGraphQLDocument } from './db.types';
import type { WriteOp } from './core.apply.journal.types';
import type { ExtractSink } from './dsl.query.types';
import type { exactMutationVariables } from '../dsl/mutationVariables';

/** Non-null payload selected by a mutation's declared top-level `result` field. */
export type MutationPayload<TData> = NonNullable<TData[keyof TData]>;

export type DefinedMutation<TData, TInput> = {
  run(input: TInput): Promise<MutationPayload<TData> | null>;
  retry(tempId: string): Promise<MutationPayload<TData> | null>;
  discard(tempId: string): void;
  use(): MutationHandle<MutationPayload<TData>, TInput>;
};

export type MutationModel = {
  modelId: string;
  find(id: string | null | undefined): unknown;
  normalize(input: unknown): { id: string };
  insert(row: { id: string }): void;
  update(id: string, patch: Record<string, unknown>): void;
  destroy(id: string): void;
};

type ScopePlacementHandle = {
  modelId: string;
};

/** A server-order scope plus the mutation-input mapping that selects its concrete scope value. */
export type ScopePlacement<TInput> = {
  /** Server-order scope receiving the optimistic temp row. */
  scope: ScopePlacementHandle;
  /** Derive the destination scope value from the mutation input. */
  value: (input: TInput) => unknown;
};

/** Context shared by optimistic and transport-variable builders for one mutation run. */
export type OptimisticCtx = { tempId: string | null; operationId: string };

export type MutateCallbacks<TData> = {
  /** Receives null when the call was skipped by a pending duplicate or a committed `once` key. */
  onSuccess?: (data: TData | null) => void;
  /** Called with the thrown error after rollback has already run. */
  onError?: (error: Error) => void;
  /** Called after `onSuccess`/`onError`, regardless of outcome. */
  onSettled?: () => void;
};

export type InsertOptimistic<TData, TInput, TStored, TNode> = {
  model: MutationModel;
  tempIdPrefix?: string;
  build: (input: TInput, ctx: OptimisticCtx) => TStored;
  selectServerNode: (data: TData) => TNode | null | undefined;
  existingTempId?: (input: TInput) => string | null;
  failure?: 'keep' | 'rollback';
  onFailurePatch?: (input: TInput) => Partial<TStored>;
  onRetryPatch?: (input: TInput) => Partial<TStored>;
  prependTo?: ScopePlacement<TInput>;
  appendTo?: ScopePlacement<TInput>;
  correlate?: MutationCorrelate;
};

/**
 * Channel-agnostic temp-row correlation rule for an insert-optimistic mutation: when any write
 * channel (query landing, another mutation's extract sink, ingest, seed) plans a server row that is
 * not in the store yet, the core matches it against this mutation's still-open temp rows and plans
 * a replace instead of a duplicate insert. `fields` compare candidate/incoming values with
 * `Object.is`; `match` further narrows candidates; `createdAtWindowMs` rejects candidates whose
 * `createdAt` distance from the incoming row exceeds the window (missing/unparseable `createdAt` on
 * either side rejects the candidate). Declarative and opt-in: without a declaration no channel
 * correlates, because a false merge silently poisons row identity.
 */
export type MutationCorrelate = {
  fields: ReadonlyArray<string>;
  match?: (candidate: Record<string, unknown>, incoming: Record<string, unknown>) => boolean;
  createdAtWindowMs?: number;
};

export type PatchOptimistic<TInput, TStored> = {
  method: 'patch';
  model: MutationModel;
  selectId: (input: TInput) => string;
  selectPatch: (input: TInput) => Partial<TStored>;
};

export type DestroyOptimistic<TInput> = {
  method: 'destroy';
  model: MutationModel;
  selectId: (input: TInput) => string;
};

export type RespondOptimistic<TData, TInput, TNode> = {
  model: MutationModel;
  selectServerNode: (data: TData) => TNode | null | undefined;
  respond: (input: TInput, ctx: { tempId: string; operationId: string }) => TData;
  prependTo?: ScopePlacement<TInput>;
  appendTo?: ScopePlacement<TInput>;
};

export type MutationConfig<TData, TInput, TStored, TNode> = {
  /** The GraphQL mutation document. */
  document: DbGraphQLDocument<TData, any>;
  /** Response field owning the mutation payload; a null payload is treated as failure and rolls back. */
  result: Extract<keyof TData, string>;
  /** Build transport variables from the mutation input and its optimistic operation context. */
  mapInput?: (input: TInput, ctx: OptimisticCtx) => Record<string, unknown>;
  /** Internal model-action builder for an exact generated GraphQL variables object. */
  [exactMutationVariables]?: (input: TInput, ctx: OptimisticCtx) => Record<string, unknown>;
  /** Optimistic local write applied before the network call, undone on error/rollback. */
  optimistic?: InsertOptimistic<TData, TInput, TStored, TNode> | RespondOptimistic<TData, TInput, TNode> | PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput>;
  /** Cross-model sideloads from the response, applied in the same transaction as the commit. */
  extract?: (ctx: { data: TData }) => ExtractSink[];
  /** Double-tap guard key. Pending duplicates are skipped; null skips dedupe for that input. */
  dedupe?: false | { key: (input: TInput) => string | null };
  /** Retain a committed dedupe key until runtime reset instead of releasing it after commit. */
  once?: boolean;
  /** Called synchronously right after the optimistic write (if any), before the transport call starts. */
  onMutate?: (input: TInput, ctx: OptimisticCtx) => void;
  /** Called after the response commits successfully, after extract sinks and preserve-on-commit have applied. */
  onCommit?: (data: TData, ctx: OptimisticCtx & { input: TInput }) => void;
  /** Called after a failed run has rolled back its optimistic write (if any) and closed the operation. */
  onError?: (error: Error, ctx: OptimisticCtx & { input: TInput }) => void;
  /** Called after a successful commit to invalidate related queries; errors are logged and do not fail the mutation. */
  invalidate?: (ctx: { input: TInput; data: TData }) => void;
  /** Called after a successful commit for analytics/tracking; errors are logged and do not fail the mutation. */
  track?: (ctx: { input: TInput; data: TData }) => void;
};

export type MutationHandle<TData, TInput> = {
  mutate(input: TInput, callbacks?: MutateCallbacks<TData>): void;
  mutateAsync(input: TInput): Promise<TData | null>;
  isPending: boolean;
  error: Error | null;
};

export type MutationResponder<TData, TInput, TNode> = {
  planFromRespond(data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>, input: TInput): WriteOp[];
  inverseFromRespond(data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>): WriteOp[];
};

/** `defineCommand` configuration: a mutation without optimistic writes and with opt-out dedupe. */
export type CommandConfig<TData, TInput, TStored extends { id: string }, TNode> = Omit<MutationConfig<TData, TInput, TStored, TNode>, 'dedupe' | 'optimistic'> & {
  dedupe?: false | MutationConfig<TData, TInput, TStored, TNode>['dedupe'];
};

/** Internal wiring handed to the mutation runtime by `defineMutation`. */
export type MutationRuntimeContext<TData, TInput, TStored, TNode> = {
  config: MutationConfig<TData, TInput, TStored, TNode>;
  optimisticConfig: MutationConfig<TData, TInput, TStored, TNode>['optimistic'];
  planFromRespond: (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>, input: TInput) => WriteOp[];
  inverseFromRespond: (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>) => WriteOp[];
};
