import type { DbGraphQLDocument } from '../types';
import type { ExtractSink } from '../dsl/defineQuery';

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
  result: string;
  /** Build transport variables from the mutation input and its optimistic operation context. */
  mapInput?: (input: TInput, ctx: OptimisticCtx) => Record<string, unknown>;
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
