import { useCallback, useRef, useState } from 'react';
import type { DbGraphQLDocument } from '../types';
import type { JournalOp } from '../core/apply/journal';
import { expandPlan, hasDependentCascade } from '../core/relations';
import { getDbLogger } from '../core/logger';
import { generateTempId } from '../utils/generateTempId';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState, getRuntimeGeneration } from './configure';
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
};

export type OptimisticCtx = { tempId: string | null };

export type MutateCallbacks<TData> = {
  /** Receives null when the call was skipped by dedupe (already committed / pending). */
  onSuccess?: (data: TData | null) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

type InsertOptimistic<TData, TInput, TStored, TNode> = {
  model: MutationModel;
  tempIdPrefix?: string;
  build: (input: TInput, ctx: OptimisticCtx) => TStored;
  selectServerNode: (data: TData) => TNode | null | undefined;
  /** Client-only fields (visual state, local uris) carried from the optimistic row onto the committed server row. */
  preserveOnCommit?: ReadonlyArray<keyof TStored & string>;
  /** Retry path: reuse this existing optimistic row instead of inserting a new one; a failed retry keeps it. */
  existingTempId?: (input: TInput) => string | null;
};
type PatchOptimistic<TInput, TStored> = { method: 'patch'; model: MutationModel; selectId: (input: TInput) => string; selectPatch: (input: TInput) => Partial<TStored> };
type DestroyOptimistic<TInput> = { method: 'destroy'; model: MutationModel; selectId: (input: TInput) => string };

export type MutationConfig<TData, TInput, TStored, TNode> = {
  document: DbGraphQLDocument<TData, any>;
  /** Response field owning the mutation payload; a null payload is treated as failure and rolls back. */
  result: string;
  mapInput?: (input: TInput) => Record<string, unknown>;
  optimistic?: InsertOptimistic<TData, TInput, TStored, TNode> | PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput>;
  /** Cross-model sideloads from the response, applied in the SAME transaction as the commit. */
  extract?: (ctx: { data: TData }) => ExtractSink[];
  /** Idempotency: a committed key is never re-sent; a pending key blocks double-taps; null skips dedupe. */
  dedupe?: { key: (input: TInput) => string | null };
  onMutate?: (input: TInput, ctx: OptimisticCtx) => void;
  onCommit?: (data: TData, ctx: OptimisticCtx & { input: TInput }) => void;
  onError?: (error: Error, ctx: OptimisticCtx & { input: TInput }) => void;
  invalidate?: (ctx: { input: TInput; data: TData }) => void;
  track?: (ctx: { input: TInput; data: TData }) => void;
};

const isMethodOptimistic = <TData, TInput, TStored, TNode>(
  value: NonNullable<MutationConfig<TData, TInput, TStored, TNode>['optimistic']>
): value is PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput> => 'method' in value;

/** Define hook and imperative mutation paths with one lifecycle: optimistic -> transport -> single-transaction commit or rollback. */
export const defineMutation = <TData, TInput, TStored extends { id: string }, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => {
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

    if (optimistic && !isMethodOptimistic(optimistic)) {
      const reuseId = optimistic.existingTempId?.(input) ?? null;
      if (reuseId != null && optimistic.model.get(reuseId) !== undefined) {
        tempId = reuseId;
      } else {
        const newTempId = generateTempId(optimistic.tempIdPrefix ?? 'row');
        tempId = newTempId;
        insertedTempId = newTempId;
        const row = optimistic.build(input, { tempId: newTempId });
        optimistic.model.insertStored({ ...(row as Record<string, unknown>), id: newTempId });
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
        idempotencyKey: dedupeKey ?? undefined,
        createdAt: Date.now()
      });
    }
    config.onMutate?.(input, { tempId });
    const generation = getRuntimeGeneration();

    let data: TData;
    try {
      data = (await getDbRuntimeConfig().transport.mutation({ mutation: config.document, variables: { input: config.mapInput?.(input) ?? input } })).data as TData;
      if (generation !== getRuntimeGeneration()) return null;
      const payload = (data as Record<string, unknown> | null | undefined)?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);

      const ops: JournalOp[] = [];
      if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
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
      if (generation !== getRuntimeGeneration()) return null;
      if (optimistic && !isMethodOptimistic(optimistic) && insertedTempId) {
        getApplyRuntime().apply(expandPlan([{ kind: 'destroy', model: optimistic.model.modelId, ids: [insertedTempId], tombstone: false }]));
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && previous && typeof previous === 'object') {
        const previousRecord = previous as Record<string, unknown>;
        const restore: Record<string, unknown> = { ...previousRecord };
        for (const key of Object.keys(optimistic.selectPatch(input) as Record<string, unknown>)) {
          if (!(key in previousRecord)) restore[key] = undefined;
        }
        optimistic.model.patch(optimistic.selectId(input), restore);
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && previous && typeof previous === 'object') {
        getApplyRuntime().apply(expandPlan(optimistic.model.__planRestore?.(previous, previousMemberships) ?? [{ kind: 'upsert', model: optimistic.model.modelId, rows: [previous], origin: 'replace' }]));
      }
      if (tracked) operations.close(operationId, 'rolledback');
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'mutation', model: optimistic?.model.modelId });
      } catch (observerError) {
        getDbLogger().error('defineMutation onSyncError failed', { error: observerError });
      }
      config.onError?.(error as Error, { tempId, input });
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
    runCommittedCallback('onCommit', () => config.onCommit?.(data, { tempId, input }));
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
