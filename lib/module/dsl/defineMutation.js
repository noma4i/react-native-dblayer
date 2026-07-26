"use strict";

import { useCallback, useRef, useState } from 'react';
import { hasDependentCascade } from "../core/relations.js";
import { getDbLogger } from "../core/logger.js";
import { generateTempId } from "../utils/generateTempId.js";
import { createGenerationFence } from "../utils/runtimePrimitives.js";
import { isRecord } from "../utils/normalizeHelpers.js";
import { registerBootValidation } from "./bootValidations.js";
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from "./configure.js";
import { getInternalModelHandle, getInternalScopeHandle } from "../core/internalHandles.js";
import { registerReset } from "../core/reset.js";
const failedInputsByTempId = new Map();
registerReset(() => {
  failedInputsByTempId.clear();
});

/** Internal shared replacement seam for mutation commits and `Model.replace` reconciliation. */
export const clearFailedOptimisticMutation = (model, tempId) => {
  const operations = getOperationState();
  const operation = operations.failedFor(model, tempId);
  if (operation) operations.clearFailed(operation.operationId);
  failedInputsByTempId.delete(tempId);
};

/** A server-order scope plus the mutation-input mapping that selects its concrete scope value. */

/**
 * Context shared by optimistic and transport-variable builders for one mutation run.
 * Send `operationId` to the server, echo it on subscription events, and pass it as
 * `operationId` in the declaration returned by `defineIngest` to skip committed echoes.
 */

/**
 * Optimistic insert: writes a temp row immediately, then replaces it with the server node on commit
 * (or removes it on error/rollback). Field continuity and merge semantics are model-owned through `write.groups`, not mutation-owned.
 */

/** Optimistic patch: applies a partial update immediately, restoring the previous values on error. */

/**
 * Optimistic destroy: removes the row immediately, restoring it (and its scope memberships) on error.
 * Throws at run time if the model has a dependent cascade, since a cascaded destroy cannot be rolled back.
 */

const isMethodOptimistic = value => 'method' in value;
const isRespondOptimistic = value => 'respond' in value;

/**
 * Define hook and imperative mutation paths with one lifecycle: optimistic write -> transport call ->
 * single-transaction commit (or rollback of the optimistic write on error/dedupe-skip). Dedupe, extract
 * sinks, and lifecycle callbacks (`onMutate`/`onCommit`/`onError`/`invalidate`/`track`) all run through
 * the same `run` path for both the hook and the direct call.
 *
 * @param config Document, result field, optional optimistic write, in-flight dedupe key, `once` retention, extract sinks, and lifecycle callbacks.
 * @returns `{ run, use }`. `run(input)` executes one mutation outside React, resolving to the response data,
 * or `null` when dedupe skipped it. `use()` is a hook returning `{ mutate, mutateAsync, isPending, error }`,
 * where `mutate` fires-and-forgets with optional `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
export const defineMutation = config => {
  if (config.once && config.dedupe === false) throw new Error('once cannot be combined with dedupe: false');
  const optimisticConfig = config.optimistic;
  if (optimisticConfig && isRespondOptimistic(optimisticConfig) && (`build` in optimisticConfig || `method` in optimisticConfig)) {
    throw new Error(`optimistic respond cannot be combined with build or method`);
  }
  if (optimisticConfig && isMethodOptimistic(optimisticConfig) && (`prependTo` in optimisticConfig || `appendTo` in optimisticConfig)) {
    throw new Error(`optimistic prependTo/appendTo requires an insert optimistic config`);
  }
  if (optimisticConfig && isMethodOptimistic(optimisticConfig) && optimisticConfig.method === 'destroy') {
    registerBootValidation(() => {
      if (hasDependentCascade(optimisticConfig.model.modelId)) {
        throw new Error(`${optimisticConfig.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
      }
    });
  }
  if (optimisticConfig && !isMethodOptimistic(optimisticConfig)) {
    if (optimisticConfig.prependTo && optimisticConfig.appendTo) throw new Error(`optimistic prependTo and appendTo are mutually exclusive`);
    const placement = optimisticConfig.prependTo ?? optimisticConfig.appendTo;
    if (placement && !getInternalScopeHandle(placement.scope).isServerOrder()) throw new Error(`optimistic prependTo/appendTo requires a server-order scope`);
    if (placement && placement.scope.modelId !== optimisticConfig.model.modelId) throw new Error(`optimistic prependTo/appendTo scope must belong to the optimistic model`);
  }
  const planFromRespond = (data, context, optimistic, input) => {
    const payload = data?.[config.result];
    if (payload == null) throw new Error(`${config.result} returned no data`);
    const node = optimistic.selectServerNode(data);
    const ops = [];
    if (node != null) {
      const raw = node;
      const id = raw.id === `` || raw.id == null ? context.tempId : String(raw.id);
      const row = {
        ...raw,
        id
      };
      if (context.tempId && id !== context.tempId && optimistic.model.find(context.tempId) !== undefined) ops.push(...getInternalModelHandle(optimistic.model).planReplace(context.tempId, row));else ops.push(...getInternalModelHandle(optimistic.model).planRows([row]));
      const placement = optimistic.prependTo ?? optimistic.appendTo;
      if (placement && context.tempId && id === context.tempId) ops.push(...getInternalScopeHandle(placement.scope).planPlacement(placement.value(input), id, optimistic.prependTo ? 'prepend' : 'append'));
    }
    for (const sink of config.extract?.({
      data
    }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
    return ops;
  };
  const inverseFromRespond = (data, context, optimistic) => {
    const targets = [];
    const node = optimistic.selectServerNode(data);
    if (node) targets.push({
      model: optimistic.model,
      id: node.id === `` || node.id == null ? context.tempId : String(node.id)
    });
    for (const sink of config.extract?.({
      data
    }) ?? []) {
      const model = sink.into;
      for (const row of sink.rows) if (isRecord(row) && row.id != null) targets.push({
        model,
        id: String(row.id)
      });
    }
    return targets.flatMap(({
      model,
      id
    }) => {
      const previous = model.find?.(id);
      if (previous === undefined) return [{
        kind: 'destroy',
        model: model.modelId,
        ids: [id],
        tombstone: false
      }];
      const internal = getInternalModelHandle(model);
      const memberships = internal.captureMembership(id);
      return internal.planRestore(previous, memberships);
    });
  };
  const runWithTempId = async (input, forcedTempId) => {
    const operations = getOperationState();
    const dedupeKey = config.dedupe === false ? undefined : config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (config.once && operations.hasCommitted(dedupeKey)) return null;
      if (operations.hasPending(dedupeKey)) return null;
    }
    const optimistic = config.optimistic;
    const tracked = optimistic != null || dedupeKey != null;
    const operationId = generateTempId('op');
    let tempId = null;
    let insertedTempId = null;
    let previous = null;
    let previousMemberships = [];
    let respondInverse = [];
    let context;
    let data;
    const methodPatchOptimistic = optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch';
    const generationFence = createGenerationFence();
    try {
      if (tracked && methodPatchOptimistic) {
        const patch = optimistic.selectPatch(input);
        operations.begin({
          operationId,
          model: optimistic.model.modelId,
          tempIds: [],
          rowIds: [String(optimistic.selectId(input))],
          intent: 'patch',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          patchedFields: Object.keys(patch),
          patchedValues: patch,
          createdAt: Date.now()
        });
      }
      if (optimistic && isRespondOptimistic(optimistic)) {
        tempId = generateTempId('row');
        insertedTempId = tempId;
        const fabricated = optimistic.respond(input, {
          tempId,
          operationId
        });
        respondInverse = inverseFromRespond(fabricated, {
          tempId,
          operationId
        }, optimistic);
        const optimisticOps = planFromRespond(fabricated, {
          tempId,
          operationId
        }, optimistic, input);
        if (optimisticOps.length > 0) getApplyRuntime().apply(optimisticOps);
      } else if (optimistic && !isMethodOptimistic(optimistic)) {
        const reuseId = forcedTempId ?? optimistic.existingTempId?.(input) ?? null;
        if (reuseId != null && (forcedTempId != null || optimistic.model.find(reuseId) !== undefined)) {
          tempId = reuseId;
        } else {
          const newTempId = generateTempId(optimistic.tempIdPrefix ?? 'row');
          tempId = newTempId;
          insertedTempId = newTempId;
          const row = optimistic.build(input, {
            tempId: newTempId,
            operationId
          });
          const placement = optimistic.prependTo ?? optimistic.appendTo;
          const position = optimistic.prependTo ? 'prepend' : 'append';
          const ops = getInternalModelHandle(optimistic.model).planRows([{
            ...row,
            id: newTempId
          }]);
          if (placement) {
            ops.push(...getInternalScopeHandle(placement.scope).planPlacement(placement.value(input), newTempId, position));
          }
          getApplyRuntime().apply(ops);
        }
      } else if (optimistic && optimistic.method === 'patch') {
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        getInternalModelHandle(optimistic.model).applyPatch(String(id), optimistic.selectPatch(input), operationId);
      } else if (optimistic && optimistic.method === 'destroy') {
        if (hasDependentCascade(optimistic.model.modelId)) {
          throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
        }
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        previousMemberships = getInternalModelHandle(optimistic.model).captureMembership(id);
        optimistic.model.destroy(id);
      }
      if (tracked && !methodPatchOptimistic) {
        const operationIds = tempId ? [tempId] : optimistic && isMethodOptimistic(optimistic) ? [String(optimistic.selectId(input))] : [];
        operations.begin({
          operationId,
          model: optimistic?.model.modelId ?? '',
          tempIds: tempId ? [tempId] : [],
          rowIds: operationIds,
          intent: optimistic ? isMethodOptimistic(optimistic) ? optimistic.method : 'insert' : 'patch',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          ...(optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' ? (() => {
            const patch = optimistic.selectPatch(input);
            return {
              patchedFields: Object.keys(patch),
              patchedValues: patch
            };
          })() : {}),
          createdAt: Date.now()
        });
      }
      context = {
        tempId,
        operationId
      };
      config.onMutate?.(input, context);
      data = (await getDbRuntimeConfig().transport.mutation({
        mutation: config.document,
        variables: {
          input: config.mapInput?.(input, context) ?? input
        }
      })).data;
      if (!generationFence.isCurrent()) return null;
      const payload = data?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);
      const ops = [];
      if (optimistic && isRespondOptimistic(optimistic)) {
        const respondOps = planFromRespond(data, context, optimistic, input);
        ops.push(...respondOps);
      } else if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) {
          ops.push(...getInternalModelHandle(optimistic.model).planReplace(tempId, node));
        }
      }
      for (const sink of config.extract?.({
        data
      }) ?? []) {
        ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
      }
      const commitOps = methodPatchOptimistic ? ops.map(op => op.kind === 'upsert' && op.model === optimistic.model.modelId ? {
        ...op,
        operationId
      } : op) : ops;
      if (commitOps.length > 0) getApplyRuntime().apply(commitOps);
      if (tracked) operations.close(operationId, 'committed');
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      if (optimistic && isRespondOptimistic(optimistic) && insertedTempId) {
        if (respondInverse.length > 0) getApplyRuntime().apply(respondInverse);
      } else if (optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic)) {
        if (optimistic.failure === 'rollback') {
          if (insertedTempId) getApplyRuntime().apply([{
            kind: 'destroy',
            model: optimistic.model.modelId,
            ids: [insertedTempId],
            tombstone: false
          }]);
        } else if (tempId) {
          const patch = optimistic.onFailurePatch?.(input);
          if (patch) optimistic.model.update(tempId, patch);
          failedInputsByTempId.set(tempId, input);
        }
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && isRecord(previous)) {
        const previousRecord = previous;
        const patchValues = optimistic.selectPatch(input);
        const current = optimistic.model.find(optimistic.selectId(input));
        const rowId = String(optimistic.selectId(input));
        const operations = getOperationState();
        const restore = {};
        for (const key of Object.keys(patchValues)) {
          const other = operations.latestPendingValue(optimistic.model.modelId, rowId, key, operationId);
          if (other.found) {
            restore[key] = other.value;
            continue;
          }
          if (current && !Object.is(current[key], patchValues[key])) continue;
          restore[key] = key in previousRecord ? previousRecord[key] : undefined;
        }
        if (Object.keys(restore).length > 0) getInternalModelHandle(optimistic.model).applyPatch(String(optimistic.selectId(input)), restore, operationId);
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && isRecord(previous)) {
        getApplyRuntime().apply(getInternalModelHandle(optimistic.model).planRestore(previous, previousMemberships));
      }
      if (tracked) operations.close(operationId, optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic) && optimistic.failure !== 'rollback' ? 'failed' : 'rolledback');
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
      } catch (loggerError) {
        /** Logger failure is intentionally swallowed - a throwing logger must not break commit callbacks. */
        void loggerError;
      }
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'mutation',
          model: optimistic?.model.modelId
        });
      } catch (observerError) {
        /** Observer failure is intentionally swallowed - a throwing onSyncError observer must not break commit callbacks. */
        void observerError;
      }
    };
    const runCommittedCallback = (callback, run) => {
      try {
        run();
      } catch (error) {
        reportCallbackError(error, callback);
      }
    };
    runCommittedCallback('onCommit', () => config.onCommit?.(data, {
      ...context,
      input
    }));
    runCommittedCallback('invalidate', () => config.invalidate?.({
      input,
      data
    }));
    runCommittedCallback('track', () => config.track?.({
      input,
      data
    }));
    return data;
  };
  const run = input => runWithTempId(input);
  const retry = async tempId => {
    const input = failedInputsByTempId.get(tempId);
    if (input === undefined || !optimisticConfig || isMethodOptimistic(optimisticConfig) || isRespondOptimistic(optimisticConfig)) return null;
    clearFailedOptimisticMutation(optimisticConfig.model.modelId, tempId);
    const patch = optimisticConfig.onRetryPatch?.(input);
    if (patch) optimisticConfig.model.update(tempId, patch);
    return runWithTempId(input, tempId);
  };
  const discard = tempId => {
    if (!optimisticConfig || isMethodOptimistic(optimisticConfig) || isRespondOptimistic(optimisticConfig)) return;
    if (!getOperationState().failedFor(optimisticConfig.model.modelId, tempId)) return;
    optimisticConfig.model.destroy(tempId);
    clearFailedOptimisticMutation(optimisticConfig.model.modelId, tempId);
  };
  return {
    run,
    /** Re-run a failed optimistic mutation for its kept temp row. Returns null when no failed input is known (e.g. after an app restart). */
    retry,
    /** Destroy a kept failed row and clear its failure record. */
    discard,
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
      const mutate = useCallback((input, callbacks) => {
        mutateAsync(input).then(data => callbacks?.onSuccess?.(data)).catch(nextError => callbacks?.onError?.(nextError)).finally(() => callbacks?.onSettled?.());
      }, [mutateAsync]);
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