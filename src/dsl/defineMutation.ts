import { useCallback, useRef, useState } from 'react';
import type { DbGraphQLDocument } from '../types';
import type { JournalOp } from '../core/apply/journal';
import { expandPlan, hasDependentCascade } from '../core/relations';
import { getDbLogger } from '../core/logger';
import { generateTempId } from '../utils/generateTempId';
import { createGenerationFence } from '../utils/runtimePrimitives';
import { isRecord } from '../utils/normalizeHelpers';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from './configure';
import type { ExtractSink } from './defineQuery';

type MutationModel = {
  modelId: string;
  get(id: string | null | undefined): unknown;
  normalize(input: unknown): { id: string };
  insertStored(row: { id: string }): void;
  patch(id: string, patch: Record<string, unknown>): void;
  destroy(id: string): void;
  __planReplace?(oldId: string, next: unknown): JournalOp[];
  __captureMembership?(id: string): Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>;
  __planRestore?(next: unknown, memberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }>): JournalOp[];
  __planRows?(rows: unknown[]): JournalOp[];
};

type ScopePlacementHandle = {
  modelId: string;
  __isServerOrder?: () => boolean;
  __planPlacement?: (scopeValue: any, id: string, position: 'prepend' | 'append') => JournalOp[];
};

/** A server-order scope plus the mutation-input mapping that selects its concrete scope value. */
export type ScopeHandleExpr<TInput> = {
  /** Server-order scope receiving the optimistic temp row. */
  scope: ScopePlacementHandle;
  /** Derive the destination scope value from the mutation input. */
  value: (input: TInput) => unknown;
};

/**
 * Context shared by optimistic and transport-variable builders for one mutation run.
 * Send `operationId` to the server, echo it on subscription events, and pass it as
 * `operationId` in the declaration returned by `defineIngest` to skip committed echoes.
 */
export type OptimisticCtx = { tempId: string | null; operationId: string };

export type MutateCallbacks<TData> = {
  /** Receives null when the call was skipped by dedupe (already committed / pending). */
  onSuccess?: (data: TData | null) => void;
  /** Called with the thrown error after rollback has already run. */
  onError?: (error: Error) => void;
  /** Called after `onSuccess`/`onError`, regardless of outcome. */
  onSettled?: () => void;
};

/**
 * Optimistic insert: writes a temp row immediately, then replaces it with the server node on commit
 * (or removes it on error/rollback).
 */
type InsertOptimistic<TData, TInput, TStored, TNode> = {
  /** Model the optimistic (and committed) row is written into. */
  model: MutationModel;
  /** Prefix passed to `generateTempId` for the inserted row's id. */
  tempIdPrefix?: string;
  /** Build the optimistic stored row from the mutation input and its `OptimisticCtx`. */
  build: (input: TInput, ctx: OptimisticCtx) => TStored;
  /** Pick the server-created node off the mutation response; `null`/`undefined` skips the temp-id replace. */
  selectServerNode: (data: TData) => TNode | null | undefined;
  /** Client-only fields (visual state, local uris) carried from the optimistic row onto the committed server row. */
  preserveOnCommit?: ReadonlyArray<keyof TStored & string>;
  /** Retry path: reuse this existing optimistic row instead of inserting a new one; a failed retry keeps it. */
  existingTempId?: (input: TInput) => string | null;
  /** Place the temp row at the top of this server-order scope; `value` derives that scope's value from the mutation input. */
  prependTo?: ScopeHandleExpr<TInput>;
  /** Place the temp row at the bottom of this server-order scope; `value` derives that scope's value from the mutation input. */
  appendTo?: ScopeHandleExpr<TInput>;
};
/** Optimistic patch: applies a partial update immediately, restoring the previous values on error. */
type PatchOptimistic<TInput, TStored> = {
  method: 'patch';
  /** Model the patch is applied to. */
  model: MutationModel;
  /** Row id to patch, derived from the mutation input. */
  selectId: (input: TInput) => string;
  /** Partial update applied immediately and re-derived on rollback to restore only the touched fields. */
  selectPatch: (input: TInput) => Partial<TStored>;
};
/**
 * Optimistic destroy: removes the row immediately, restoring it (and its scope memberships) on error.
 * Throws at run time if the model has a dependent cascade, since a cascaded destroy cannot be rolled back.
 */
type DestroyOptimistic<TInput> = {
  method: 'destroy';
  /** Model the row is destroyed from. */
  model: MutationModel;
  /** Row id to destroy, derived from the mutation input. */
  selectId: (input: TInput) => string;
};
type RespondOptimistic<TData, TInput, TNode> = {
  /** Model receiving the response node through the same normalize and swap plan as the transport response. */
  model: MutationModel;
  /** Pick the response node; an empty id is mapped to this run's temp id. */
  selectServerNode: (data: TData) => TNode | null | undefined;
  /** Fabricate a transport-shaped response for the optimistic apply; extract sinks run against it too. */
  respond: (input: TInput, ctx: { tempId: string; operationId: string }) => TData;
  /** Place a fabricated temp row at the top of this server-order scope. */
  prependTo?: ScopeHandleExpr<TInput>;
  /** Place a fabricated temp row at the bottom of this server-order scope. */
  appendTo?: ScopeHandleExpr<TInput>;
};

export type MutationConfig<TData, TInput, TStored, TNode> = {
  /** The GraphQL mutation document. */
  document: DbGraphQLDocument<TData, any>;
  /** Response field owning the mutation payload; a null payload is treated as failure and rolls back. */
  result: string;
  /** Build transport variables from the mutation input and its optimistic operation context. */
  mapInput?: (input: TInput, ctx: OptimisticCtx) => Record<string, unknown>;
  /**
   * Optimistic local write applied before the network call, undone on error/rollback: an insert (writes a
   * temp row, replaced by the server node on commit), a `method: 'patch'`, or a `method: 'destroy'`. Omit
   * for mutations with no local write of their own (e.g. pure side-effect calls).
   */
  optimistic?: InsertOptimistic<TData, TInput, TStored, TNode> | RespondOptimistic<TData, TInput, TNode> | PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput>;
  /** Cross-model sideloads from the response, applied in the SAME transaction as the commit. */
  extract?: (ctx: { data: TData }) => ExtractSink[];
  /** Idempotency: a committed key is never re-sent; a pending key blocks double-taps; null skips dedupe. */
  dedupe?: { key: (input: TInput) => string | null };
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

const isMethodOptimistic = <TData, TInput, TStored, TNode>(
  value: NonNullable<MutationConfig<TData, TInput, TStored, TNode>['optimistic']>
): value is PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput> => 'method' in value;

const isRespondOptimistic = <TData, TInput, TStored, TNode>(
  value: NonNullable<MutationConfig<TData, TInput, TStored, TNode>['optimistic']>
): value is RespondOptimistic<TData, TInput, TNode> => 'respond' in value;

/**
 * Define hook and imperative mutation paths with one lifecycle: optimistic write -> transport call ->
 * single-transaction commit (or rollback of the optimistic write on error/dedupe-skip). Dedupe, extract
 * sinks, and lifecycle callbacks (`onMutate`/`onCommit`/`onError`/`invalidate`/`track`) all run through
 * the same `run` path for both the hook and the direct call.
 *
 * @param config Document, result field, optional optimistic write, dedupe key, extract sinks, and lifecycle callbacks.
 * @returns `{ run, use }`. `run(input)` executes one mutation outside React, resolving to the response data,
 * or `null` when dedupe skipped it. `use()` is a hook returning `{ mutate, mutateAsync, isPending, error }`,
 * where `mutate` fires-and-forgets with optional `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
export const defineMutation = <TData, TInput, TStored extends { id: string }, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => {
  const optimisticConfig = config.optimistic;
  if (optimisticConfig && isRespondOptimistic(optimisticConfig) && (`build` in optimisticConfig || `method` in optimisticConfig)) {
    throw new Error(`optimistic respond cannot be combined with build or method`);
  }
  if (optimisticConfig && isMethodOptimistic(optimisticConfig) && (`prependTo` in optimisticConfig || `appendTo` in optimisticConfig)) {
    throw new Error(`optimistic prependTo/appendTo requires an insert optimistic config`);
  }
  if (optimisticConfig && !isMethodOptimistic(optimisticConfig)) {
    if (optimisticConfig.prependTo && optimisticConfig.appendTo) throw new Error(`optimistic prependTo and appendTo are mutually exclusive`);
    const placement = optimisticConfig.prependTo ?? optimisticConfig.appendTo;
    if (placement && placement.scope.__isServerOrder?.() !== true) throw new Error(`optimistic prependTo/appendTo requires a server-order scope`);
    if (placement && placement.scope.modelId !== optimisticConfig.model.modelId) throw new Error(`optimistic prependTo/appendTo scope must belong to the optimistic model`);
  }

  const planFromRespond = (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>, input: TInput): JournalOp[] => {
    const payload = (data as Record<string, unknown> | null | undefined)?.[config.result];
    if (payload == null) throw new Error(`${config.result} returned no data`);
    const node = optimistic.selectServerNode(data);
    const ops: JournalOp[] = [];
    if (node != null) {
      const raw = node as Record<string, unknown>;
      const id = raw.id === `` || raw.id == null ? context.tempId : String(raw.id);
      const row = { ...raw, id };
      if (context.tempId && id !== context.tempId && optimistic.model.get(context.tempId) !== undefined) ops.push(...(optimistic.model.__planReplace?.(context.tempId, row) ?? []));
      else ops.push(...(optimistic.model.__planRows?.([row]) ?? [{ kind: 'upsert', model: optimistic.model.modelId, rows: [row] }]));
      const placement = optimistic.prependTo ?? optimistic.appendTo;
      if (placement && context.tempId && id === context.tempId)
        ops.push(...(placement.scope.__planPlacement?.(placement.value(input), id, optimistic.prependTo ? 'prepend' : 'append') ?? []));
    }
    for (const sink of config.extract?.({ data }) ?? []) ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
    return ops;
  };
  const inverseFromRespond = (data: TData, context: OptimisticCtx, optimistic: RespondOptimistic<TData, TInput, TNode>): JournalOp[] => {
    const targets: Array<{ model: MutationModel; id: string }> = [];
    const node = optimistic.selectServerNode(data) as Record<string, unknown> | null | undefined;
    if (node) targets.push({ model: optimistic.model, id: node.id === `` || node.id == null ? context.tempId! : String(node.id) });
    for (const sink of config.extract?.({ data }) ?? []) {
      const model = sink.into as MutationModel;
      for (const row of sink.rows) if (isRecord(row) && typeof row.id === 'string') targets.push({ model, id: row.id });
    }
    return targets.flatMap(({ model, id }) => {
      const previous = model.get?.(id);
      if (previous === undefined) return [{ kind: 'destroy' as const, model: model.modelId, ids: [id], tombstone: false }];
      const memberships = model.__captureMembership?.(id) ?? [];
      return model.__planRestore?.(previous, memberships) ?? [{ kind: 'upsert' as const, model: model.modelId, rows: [previous], origin: 'replace' as const }];
    });
  };

  const run = async (input: TInput): Promise<TData | null> => {
    const operations = getOperationState();
    const dedupeKey = config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (operations.hasCommitted(dedupeKey)) return null;
      if (operations.hasPending(dedupeKey)) return null;
    }
    const optimistic = config.optimistic;
    const tracked = optimistic != null || dedupeKey != null;
    const operationId = generateTempId('op');
    let tempId: string | null = null;
    let insertedTempId: string | null = null;
    let previous: unknown = null;
    let previousMemberships: Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }> = [];
    let respondInverse: JournalOp[] = [];

    if (optimistic && isRespondOptimistic(optimistic)) {
      tempId = generateTempId('row');
      insertedTempId = tempId;
      const fabricated = optimistic.respond(input, { tempId, operationId });
      respondInverse = inverseFromRespond(fabricated, { tempId, operationId }, optimistic);
      const optimisticOps = planFromRespond(fabricated, { tempId, operationId }, optimistic, input);
      if (optimisticOps.length > 0) getApplyRuntime().apply(expandPlan(optimisticOps));
    } else if (optimistic && !isMethodOptimistic(optimistic)) {
      const reuseId = optimistic.existingTempId?.(input) ?? null;
      if (reuseId != null && optimistic.model.get(reuseId) !== undefined) {
        tempId = reuseId;
      } else {
        const newTempId = generateTempId(optimistic.tempIdPrefix ?? 'row');
        tempId = newTempId;
        insertedTempId = newTempId;
        const row = optimistic.build(input, { tempId: newTempId, operationId });
        const placement = optimistic.prependTo ?? optimistic.appendTo;
        const position = optimistic.prependTo ? 'prepend' : 'append';
        const ops = optimistic.model.__planRows?.([{ ...(row as Record<string, unknown>), id: newTempId }]) ?? [
          { kind: 'upsert' as const, model: optimistic.model.modelId, rows: [{ ...(row as Record<string, unknown>), id: newTempId }] }
        ];
        if (placement) ops.push(...(placement.scope.__planPlacement?.(placement.value(input), newTempId, position) ?? []));
        getApplyRuntime().apply(expandPlan(ops));
      }
    } else if (optimistic && optimistic.method === 'patch') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.patch(id, optimistic.selectPatch(input) as Record<string, unknown>);
    } else if (optimistic && optimistic.method === 'destroy') {
      if (hasDependentCascade(optimistic.model.modelId)) {
        throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
      }
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      previousMemberships = optimistic.model.__captureMembership?.(id) ?? [];
      optimistic.model.destroy(id);
    }
    if (tracked) {
      operations.begin({
        operationId,
        model: optimistic?.model.modelId ?? '',
        tempIds: tempId ? [tempId] : [],
        intent: optimistic ? (isMethodOptimistic(optimistic) ? optimistic.method : 'insert') : 'patch',
        idempotencyKey: dedupeKey ?? operationId,
        createdAt: Date.now()
      });
    }
    const context: OptimisticCtx = { tempId, operationId };
    config.onMutate?.(input, context);
    const generationFence = createGenerationFence();

    let data: TData;
    try {
      data = (await getDbRuntimeConfig().transport.mutation({ mutation: config.document, variables: { input: config.mapInput?.(input, context) ?? input } })).data as TData;
      if (!generationFence.isCurrent()) return null;
      const payload = (data as Record<string, unknown> | null | undefined)?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);

      const ops: JournalOp[] = [];
      if (optimistic && isRespondOptimistic(optimistic)) {
        ops.push(...planFromRespond(data, context, optimistic, input));
      } else if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) {
          ops.push(...(optimistic.model.__planReplace?.(tempId, node) ?? []));
          if (optimistic.preserveOnCommit?.length) {
            const current = optimistic.model.get(tempId) as Record<string, unknown> | undefined;
            if (current) {
              const preserved: Record<string, unknown> = {};
              for (const field of optimistic.preserveOnCommit) {
                if (current[field] !== undefined) preserved[field] = current[field];
              }
              if (Object.keys(preserved).length > 0) {
                ops.push({ kind: 'patch', model: optimistic.model.modelId, id: optimistic.model.normalize(node).id, patch: preserved });
              }
            }
          }
        }
      }
      for (const sink of config.extract?.({ data }) ?? []) {
        ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
      }
      if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));

      if (tracked) operations.close(operationId, 'committed');
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      if (optimistic && isRespondOptimistic(optimistic) && insertedTempId) {
        if (respondInverse.length > 0) getApplyRuntime().apply(expandPlan(respondInverse));
      } else if (optimistic && !isMethodOptimistic(optimistic) && insertedTempId) {
        getApplyRuntime().apply(expandPlan([{ kind: 'destroy', model: optimistic.model.modelId, ids: [insertedTempId], tombstone: false }]));
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && isRecord(previous)) {
        const previousRecord = previous as Record<string, unknown>;
        const restore: Record<string, unknown> = { ...previousRecord };
        for (const key of Object.keys(optimistic.selectPatch(input) as Record<string, unknown>)) {
          if (!(key in previousRecord)) restore[key] = undefined;
        }
        optimistic.model.patch(optimistic.selectId(input), restore);
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && isRecord(previous)) {
        getApplyRuntime().apply(
          expandPlan(optimistic.model.__planRestore?.(previous, previousMemberships) ?? [{ kind: 'upsert', model: optimistic.model.modelId, rows: [previous], origin: 'replace' }])
        );
      }
      if (tracked) operations.close(operationId, 'rolledback');
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'mutation', model: optimistic?.model.modelId });
      } catch (observerError) {
        getDbLogger().error('defineMutation onSyncError failed', { error: observerError });
      }
      config.onError?.(error as Error, { ...context, input });
      throw error;
    }
    const reportCallbackError = (error: unknown, callback: string): void => {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbLogger().error('defineMutation post-commit callback failed', { callback, error: reported });
      } catch {}
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'mutation', model: optimistic?.model.modelId });
      } catch {}
    };
    const runCommittedCallback = (callback: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        reportCallbackError(error, callback);
      }
    };
    runCommittedCallback('onCommit', () => config.onCommit?.(data, { ...context, input }));
    runCommittedCallback('invalidate', () => config.invalidate?.({ input, data }));
    runCommittedCallback('track', () => config.track?.({ input, data }));
    return data;
  };

  return {
    run,
    use: () => {
      const runRef = useRef(run);
      runRef.current = run;
      const [isPending, setPending] = useState(false);
      const [error, setError] = useState<Error | null>(null);
      /** Rejects on failure (RQ semantics) while still reflecting the error in hook state; resolves null on dedupe skip. */
      const mutateAsync = useCallback(async (input: TInput): Promise<TData | null> => {
        setPending(true);
        setError(null);
        try {
          return await runRef.current(input);
        } catch (nextError) {
          setError(nextError as Error);
          throw nextError;
        } finally {
          setPending(false);
        }
      }, []);
      const mutate = useCallback(
        (input: TInput, callbacks?: MutateCallbacks<TData>) => {
          mutateAsync(input)
            .then(data => callbacks?.onSuccess?.(data))
            .catch(nextError => callbacks?.onError?.(nextError as Error))
            .finally(() => callbacks?.onSettled?.());
        },
        [mutateAsync]
      );
      return { mutate, mutateAsync, isPending, error };
    }
  };
};
