"use strict";

import { createCommitEnvelope } from "../core/apply/transaction.js";
import { hasDependentCascade } from "../core/relations.js";
import { noteDataLoss } from "../core/diagnostics.js";
import { getInternalModelHandle, getInternalScopeHandle } from "../core/internalHandles.js";
import { getDbLogger } from "../core/logger.js";
import { serializeOperationInput } from "../core/planes/operationState.js";
import { retryDelayMs } from "../core/fetch/retryPolicy.js";
import { responseDataOrThrow } from "../core/transport.js";
import { generateTempId } from "../utils/generateTempId.js";
import { isRecord } from "../utils/normalizeHelpers.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from "./configure.js";
import { isMethodOptimistic, isRespondOptimistic } from "./mutationConfiguration.js";
import { registerMutationCorrelator } from "./mutationCorrelation.js";
import { createMutationResponder } from "./mutationResponder.js";

/** Internal shared replacement seam for mutation commits and `Model.replace` reconciliation. */
export const clearFailedOptimisticMutation = (model, tempId) => {
  const operations = getOperationState();
  const operation = operations.failedFor(model, tempId);
  if (operation) operations.clearFailed(operation.operationId);
};
export const createMutationRuntime = config => {
  const runtime = {
    config,
    optimisticConfig: config.optimistic,
    ...createMutationResponder(config)
  };
  if (config.optimistic && !isMethodOptimistic(config.optimistic) && !isRespondOptimistic(config.optimistic) && config.optimistic.correlate) {
    registerMutationCorrelator(config.optimistic.model.modelId, config.optimistic.correlate);
  }
  const runWithTempId = async (input, forcedTempId) => {
    const {
      config,
      inverseFromRespond,
      planFromRespond
    } = runtime;
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
    let operationContext;
    let data;
    const methodPatchOptimistic = optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch';
    const persistedFailedInput = optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic) ? serializeOperationInput(input) : null;
    const generationFence = createGenerationFence();
    try {
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
        const beginFields = {
          operationId,
          model: optimistic.model.modelId,
          tempIds: [tempId],
          rowIds: [tempId],
          intent: 'insert',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          createdAt: Date.now()
        };
        if (optimisticOps.length > 0) {
          operations.begin(beginFields, {
            persist: false
          });
          getApplyRuntime().commit(createCommitEnvelope(optimisticOps, () => operations.persistEntries()));
        } else {
          operations.begin(beginFields);
        }
      } else if (optimistic && !isMethodOptimistic(optimistic)) {
        if (persistedFailedInput && !persistedFailedInput.serializable) noteDataLoss('failed-input-unserializable', optimistic.model.modelId, 1);
        const reuseId = forcedTempId ?? optimistic.existingTempId?.(input) ?? null;
        if (reuseId != null && (forcedTempId != null || optimistic.model.find(reuseId) !== undefined)) {
          tempId = reuseId;
          operations.begin({
            operationId,
            model: optimistic.model.modelId,
            tempIds: [tempId],
            rowIds: [tempId],
            intent: 'insert',
            idempotencyKey: dedupeKey ?? operationId,
            once: config.once === true,
            ...(persistedFailedInput?.serializable ? {
              failedInput: persistedFailedInput.value
            } : {}),
            createdAt: Date.now()
          });
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
          if (placement) ops.push(...getInternalScopeHandle(placement.scope).planPlacement(placement.value(input), newTempId, position));
          operations.begin({
            operationId,
            model: optimistic.model.modelId,
            tempIds: [newTempId],
            rowIds: [newTempId],
            intent: 'insert',
            idempotencyKey: dedupeKey ?? operationId,
            once: config.once === true,
            ...(persistedFailedInput?.serializable ? {
              failedInput: persistedFailedInput.value
            } : {}),
            createdAt: Date.now()
          }, {
            persist: false
          });
          getApplyRuntime().commit(createCommitEnvelope(ops, () => operations.persistEntries()));
        }
      } else if (optimistic && optimistic.method === 'patch') {
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        const patch = optimistic.selectPatch(input);
        operations.begin({
          operationId,
          model: optimistic.model.modelId,
          tempIds: [],
          rowIds: [String(id)],
          intent: 'patch',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          patchedFields: Object.keys(patch),
          patchedValues: patch,
          createdAt: Date.now()
        }, {
          persist: false
        });
        getApplyRuntime().commit(createCommitEnvelope([{
          kind: 'patch',
          model: optimistic.model.modelId,
          id: String(id),
          patch,
          operationId
        }], () => operations.persistEntries()));
      } else if (optimistic && optimistic.method === 'destroy') {
        if (hasDependentCascade(optimistic.model.modelId)) {
          throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
        }
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        previousMemberships = getInternalModelHandle(optimistic.model).captureMembership(id);
        operations.begin({
          operationId,
          model: optimistic.model.modelId,
          tempIds: [],
          rowIds: [String(id)],
          intent: 'destroy',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          createdAt: Date.now()
        }, {
          persist: false
        });
        getApplyRuntime().commit(createCommitEnvelope([{
          kind: 'destroy',
          model: optimistic.model.modelId,
          ids: [String(id)]
        }], () => operations.persistEntries()));
      } else if (tracked) {
        operations.begin({
          operationId,
          model: '',
          tempIds: [],
          rowIds: [],
          intent: 'patch',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          createdAt: Date.now()
        });
      }
      operationContext = {
        tempId,
        operationId
      };
      config.onMutate?.(input, operationContext);
      let attempt = 1;
      while (true) {
        try {
          data = responseDataOrThrow(await getDbRuntimeConfig().transport.mutation({
            mutation: config.document,
            variables: {
              input: config.mapInput?.(input, operationContext) ?? input
            }
          }));
          break;
        } catch (error) {
          const delayMs = retryDelayMs(getDbRuntimeConfig().defaults.retry?.mutation ?? {}, error, attempt);
          if (delayMs === null) throw error;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          attempt += 1;
        }
      }
      if (!generationFence.isCurrent()) return null;
      const payload = data?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);
      const ops = [];
      if (optimistic && isRespondOptimistic(optimistic)) {
        ops.push(...planFromRespond(data, operationContext, optimistic, input));
      } else if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) ops.push(...getInternalModelHandle(optimistic.model).planReplace(tempId, node));
      }
      for (const sink of config.extract?.({
        data
      }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
      const commitOps = methodPatchOptimistic ? ops.map(op => op.kind === 'upsert' && op.model === optimistic.model.modelId ? {
        ...op,
        operationId
      } : op) : ops;
      if (tracked) {
        if (commitOps.length > 0) {
          getApplyRuntime().commit(createCommitEnvelope(commitOps, () => {
            operations.close(operationId, 'committed', {
              persist: false
            });
            return operations.persistEntries();
          }));
        } else {
          operations.close(operationId, 'committed');
        }
      } else if (commitOps.length > 0) {
        getApplyRuntime().commit(createCommitEnvelope(commitOps));
      }
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      const rollbackOps = [];
      if (optimistic && isRespondOptimistic(optimistic) && insertedTempId) {
        if (respondInverse.length > 0) rollbackOps.push(...respondInverse);
      } else if (optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic)) {
        if (optimistic.failure === 'rollback') {
          if (insertedTempId) rollbackOps.push({
            kind: 'destroy',
            model: optimistic.model.modelId,
            ids: [insertedTempId],
            tombstone: false
          });
        } else if (tempId) {
          const patch = optimistic.onFailurePatch?.(input);
          if (patch) rollbackOps.push({
            kind: 'patch',
            model: optimistic.model.modelId,
            id: tempId,
            patch: patch
          });
        }
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && isRecord(previous)) {
        const previousRecord = previous;
        const patchValues = optimistic.selectPatch(input);
        const current = optimistic.model.find(optimistic.selectId(input));
        const rowId = String(optimistic.selectId(input));
        const operationsRead = getOperationState();
        const restore = {};
        for (const key of Object.keys(patchValues)) {
          const other = operationsRead.latestPendingValue(optimistic.model.modelId, rowId, key, operationId);
          if (other.found) {
            restore[key] = other.value;
            continue;
          }
          if (current && !Object.is(current[key], patchValues[key])) continue;
          restore[key] = key in previousRecord ? previousRecord[key] : undefined;
        }
        if (Object.keys(restore).length > 0) rollbackOps.push({
          kind: 'patch',
          model: optimistic.model.modelId,
          id: rowId,
          patch: restore,
          operationId
        });
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && isRecord(previous)) {
        rollbackOps.push(...getInternalModelHandle(optimistic.model).planRestore(previous, previousMemberships));
      }
      if (tracked) {
        const status = optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic) && optimistic.failure !== 'rollback' ? 'failed' : 'rolledback';
        if (rollbackOps.length > 0) {
          getApplyRuntime().commit(createCommitEnvelope(rollbackOps, () => {
            operations.close(operationId, status, {
              persist: false
            });
            return operations.persistEntries();
          }));
        } else {
          operations.close(operationId, status);
        }
      }
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
        ...operationContext,
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
        void loggerError;
      }
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'mutation',
          model: optimistic?.model.modelId
        });
      } catch (observerError) {
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
      ...operationContext,
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
  const optimisticConfig = runtime.optimisticConfig;
  const run = input => runWithTempId(input);
  const retry = async tempId => {
    const input = getOperationState().failedFor(optimisticConfig?.model.modelId ?? '', tempId)?.failedInput;
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
    retry,
    discard
  };
};
//# sourceMappingURL=mutationRuntime.js.map