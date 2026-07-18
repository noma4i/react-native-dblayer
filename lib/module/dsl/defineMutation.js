'use strict';

import { useCallback, useRef, useState } from 'react';
import { expandPlan, hasDependentCascade } from '../core/relations.js';
import { getDbLogger } from '../core/logger.js';
import { generateTempId } from '../utils/generateTempId.js';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState, getRuntimeGeneration } from './configure.js';

/**
 * Context shared by optimistic and transport-variable builders for one mutation run.
 * Send `operationId` to the server, echo it on subscription events, and pass it as
 * `operationId` in the declaration returned by `defineIngest` to skip committed echoes.
 */

/**
 * Optimistic insert: writes a temp row immediately, then replaces it with the server node on commit
 * (or removes it on error/rollback).
 */

/** Optimistic patch: applies a partial update immediately, restoring the previous values on error. */

/**
 * Optimistic destroy: removes the row immediately, restoring it (and its scope memberships) on error.
 * Throws at run time if the model has a dependent cascade, since a cascaded destroy cannot be rolled back.
 */

const isMethodOptimistic = value => 'method' in value;

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
export const defineMutation = config => {
  const run = async input => {
    const operations = getOperationState();
    const dedupeKey = config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (operations.hasCommitted(dedupeKey)) return null;
      if (operations.hasPending(dedupeKey)) return null;
    }
    const optimistic = config.optimistic;
    const tracked = optimistic != null || dedupeKey != null;
    const operationId = generateTempId('op');
    let tempId = null;
    let insertedTempId = null;
    let previous = null;
    let previousMemberships = [];
    if (optimistic && !isMethodOptimistic(optimistic)) {
      const reuseId = optimistic.existingTempId?.(input) ?? null;
      if (reuseId != null && optimistic.model.get(reuseId) !== undefined) {
        tempId = reuseId;
      } else {
        const newTempId = generateTempId(optimistic.tempIdPrefix ?? 'row');
        tempId = newTempId;
        insertedTempId = newTempId;
        const row = optimistic.build(input, {
          tempId: newTempId,
          operationId
        });
        optimistic.model.insertStored({
          ...row,
          id: newTempId
        });
      }
    } else if (optimistic && optimistic.method === 'patch') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.patch(id, optimistic.selectPatch(input));
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
    const context = {
      tempId,
      operationId
    };
    config.onMutate?.(input, context);
    const generation = getRuntimeGeneration();
    let data;
    try {
      data = (
        await getDbRuntimeConfig().transport.mutation({
          mutation: config.document,
          variables: {
            input: config.mapInput?.(input, context) ?? input
          }
        })
      ).data;
      if (generation !== getRuntimeGeneration()) return null;
      const payload = data?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);
      const ops = [];
      if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) {
          ops.push(...(optimistic.model.__planReplace?.(tempId, node) ?? []));
          if (optimistic.preserveOnCommit?.length) {
            const current = optimistic.model.get(tempId);
            if (current) {
              const preserved = {};
              for (const field of optimistic.preserveOnCommit) {
                if (current[field] !== undefined) preserved[field] = current[field];
              }
              if (Object.keys(preserved).length > 0) {
                ops.push({
                  kind: 'patch',
                  model: optimistic.model.modelId,
                  id: optimistic.model.normalize(node).id,
                  patch: preserved
                });
              }
            }
          }
        }
      }
      for (const sink of config.extract?.({
        data
      }) ?? []) {
        ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
      }
      if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));
      if (tracked) operations.close(operationId, 'committed');
    } catch (error) {
      if (generation !== getRuntimeGeneration()) return null;
      if (optimistic && !isMethodOptimistic(optimistic) && insertedTempId) {
        getApplyRuntime().apply(
          expandPlan([
            {
              kind: 'destroy',
              model: optimistic.model.modelId,
              ids: [insertedTempId],
              tombstone: false
            }
          ])
        );
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && previous && typeof previous === 'object') {
        const previousRecord = previous;
        const restore = {
          ...previousRecord
        };
        for (const key of Object.keys(optimistic.selectPatch(input))) {
          if (!(key in previousRecord)) restore[key] = undefined;
        }
        optimistic.model.patch(optimistic.selectId(input), restore);
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && previous && typeof previous === 'object') {
        getApplyRuntime().apply(
          expandPlan(
            optimistic.model.__planRestore?.(previous, previousMemberships) ?? [
              {
                kind: 'upsert',
                model: optimistic.model.modelId,
                rows: [previous],
                origin: 'replace'
              }
            ]
          )
        );
      }
      if (tracked) operations.close(operationId, 'rolledback');
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'mutation',
          model: optimistic?.model.modelId
        });
      } catch (observerError) {
        getDbLogger().error('defineMutation onSyncError failed', {
          error: observerError
        });
      }
      config.onError?.(error, {
        ...context,
        input
      });
      throw error;
    }
    const reportCallbackError = (error, callback) => {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbLogger().error('defineMutation post-commit callback failed', {
          callback,
          error: reported
        });
      } catch {}
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'mutation',
          model: optimistic?.model.modelId
        });
      } catch {}
    };
    const runCommittedCallback = (callback, run) => {
      try {
        run();
      } catch (error) {
        reportCallbackError(error, callback);
      }
    };
    runCommittedCallback('onCommit', () =>
      config.onCommit?.(data, {
        ...context,
        input
      })
    );
    runCommittedCallback('invalidate', () =>
      config.invalidate?.({
        input,
        data
      })
    );
    runCommittedCallback('track', () =>
      config.track?.({
        input,
        data
      })
    );
    return data;
  };
  return {
    run,
    use: () => {
      const runRef = useRef(run);
      runRef.current = run;
      const [isPending, setPending] = useState(false);
      const [error, setError] = useState(null);
      /** Rejects on failure (RQ semantics) while still reflecting the error in hook state; resolves null on dedupe skip. */
      const mutateAsync = useCallback(async input => {
        setPending(true);
        setError(null);
        try {
          return await runRef.current(input);
        } catch (nextError) {
          setError(nextError);
          throw nextError;
        } finally {
          setPending(false);
        }
      }, []);
      const mutate = useCallback(
        (input, callbacks) => {
          mutateAsync(input)
            .then(data => callbacks?.onSuccess?.(data))
            .catch(nextError => callbacks?.onError?.(nextError))
            .finally(() => callbacks?.onSettled?.());
        },
        [mutateAsync]
      );
      return {
        mutate,
        mutateAsync,
        isPending,
        error
      };
    }
  };
};
//# sourceMappingURL=defineMutation.js.map
