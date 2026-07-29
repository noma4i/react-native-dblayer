"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createMutationRuntime = exports.clearFailedOptimisticMutation = void 0;
var _transaction = require("../core/apply/transaction.js");
var _relations = require("../core/relations.js");
var _diagnostics = require("../core/diagnostics.js");
var _internalHandles = require("../core/internalHandles.js");
var _logger = require("../core/logger.js");
var _operationState = require("../core/planes/operationState.js");
var _retryPolicy = require("../core/fetch/retryPolicy.js");
var _transport = require("../core/transport.js");
var _generateTempId = require("../utils/generateTempId.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _syncError = require("../core/syncError.js");
var _configure = require("./configure.js");
var _mutationConfiguration = require("./mutationConfiguration.js");
var _mutationCorrelation = require("./mutationCorrelation.js");
var _mutationResponder = require("./mutationResponder.js");
/** Internal shared replacement seam for mutation commits and `Model.replace` reconciliation. */
const clearFailedOptimisticMutation = (model, tempId) => {
  const operations = (0, _configure.getOperationState)();
  const operation = operations.failedFor(model, tempId);
  if (operation) operations.clearFailed(operation.operationId);
};
exports.clearFailedOptimisticMutation = clearFailedOptimisticMutation;
const createMutationRuntime = (config, definitionId) => {
  const runtime = {
    config,
    optimisticConfig: config.optimistic,
    ...(0, _mutationResponder.createMutationResponder)(config)
  };
  if (config.optimistic && !(0, _mutationConfiguration.isMethodOptimistic)(config.optimistic) && !(0, _mutationConfiguration.isRespondOptimistic)(config.optimistic) && config.optimistic.correlate) {
    (0, _mutationCorrelation.registerMutationCorrelator)(config.optimistic.model.modelId, definitionId, config.optimistic.correlate);
  }
  const runWithTempId = async (input, forcedTempId) => {
    const {
      config,
      inverseFromRespond,
      planFromRespond
    } = runtime;
    const operations = (0, _configure.getOperationState)();
    const dedupeKey = config.dedupe === false ? undefined : config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (config.once && operations.hasCommitted(dedupeKey)) return null;
      if (operations.hasPending(dedupeKey)) return null;
    }
    const optimistic = config.optimistic;
    const tracked = optimistic != null || dedupeKey != null;
    const operationId = (0, _generateTempId.generateTempId)('op');
    let tempId = null;
    let insertedTempId = null;
    let previous = null;
    let previousMemberships = [];
    let respondInverse = [];
    let operationContext;
    let data;
    const methodPatchOptimistic = optimistic && (0, _mutationConfiguration.isMethodOptimistic)(optimistic) && optimistic.method === 'patch';
    const persistedFailedInput = optimistic && !(0, _mutationConfiguration.isMethodOptimistic)(optimistic) && !(0, _mutationConfiguration.isRespondOptimistic)(optimistic) ? (0, _operationState.serializeOperationInput)(input) : null;
    const generationFence = (0, _runtimeGeneration.createGenerationFence)();
    try {
      if (optimistic && (0, _mutationConfiguration.isRespondOptimistic)(optimistic)) {
        tempId = (0, _generateTempId.generateTempId)('row');
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
          (0, _configure.getApplyRuntime)().commit((0, _transaction.createCommitEnvelope)(optimisticOps, [{
            kind: 'begin',
            operation: beginFields
          }]));
        } else {
          operations.begin(beginFields);
        }
      } else if (optimistic && !(0, _mutationConfiguration.isMethodOptimistic)(optimistic)) {
        if (persistedFailedInput && !persistedFailedInput.serializable) (0, _diagnostics.noteDataLoss)('failed-input-unserializable', optimistic.model.modelId, 1);
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
          const newTempId = (0, _generateTempId.generateTempId)(optimistic.tempIdPrefix ?? 'row');
          tempId = newTempId;
          insertedTempId = newTempId;
          const row = optimistic.build(input, {
            tempId: newTempId,
            operationId
          });
          const placement = optimistic.prependTo ?? optimistic.appendTo;
          const position = optimistic.prependTo ? 'prepend' : 'append';
          const ops = (0, _internalHandles.getInternalModelHandle)(optimistic.model).planRows([{
            ...row,
            id: newTempId
          }]);
          if (placement) ops.push(...(0, _internalHandles.getInternalScopeHandle)(placement.scope).planPlacement(placement.value(input), newTempId, position));
          const beginFields = {
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
          };
          (0, _configure.getApplyRuntime)().commit((0, _transaction.createCommitEnvelope)(ops, [{
            kind: 'begin',
            operation: beginFields
          }]));
        }
      } else if (optimistic && optimistic.method === 'patch') {
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        const patch = optimistic.selectPatch(input);
        const beginFields = {
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
        };
        (0, _configure.getApplyRuntime)().commit((0, _transaction.createCommitEnvelope)([{
          kind: 'patch',
          model: optimistic.model.modelId,
          id: String(id),
          patch,
          operationId
        }], [{
          kind: 'begin',
          operation: beginFields
        }]));
      } else if (optimistic && optimistic.method === 'destroy') {
        if ((0, _relations.hasDependentCascade)(optimistic.model.modelId)) {
          throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
        }
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        previousMemberships = (0, _internalHandles.getInternalModelHandle)(optimistic.model).captureMembership(id);
        const beginFields = {
          operationId,
          model: optimistic.model.modelId,
          tempIds: [],
          rowIds: [String(id)],
          intent: 'destroy',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          createdAt: Date.now()
        };
        (0, _configure.getApplyRuntime)().commit((0, _transaction.createCommitEnvelope)([{
          kind: 'destroy',
          model: optimistic.model.modelId,
          ids: [String(id)]
        }], [{
          kind: 'begin',
          operation: beginFields
        }]));
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
        if (!generationFence.isCurrent()) return null;
        try {
          data = (0, _transport.responseDataOrThrow)(await (0, _configure.getDbRuntimeConfig)().transport.mutation({
            mutation: config.document,
            variables: {
              input: config.mapInput?.(input, operationContext) ?? input
            }
          }));
          break;
        } catch (error) {
          if (!generationFence.isCurrent()) return null;
          const delayMs = (0, _retryPolicy.retryDelayMs)((0, _configure.getDbRuntimeConfig)().defaults.retry?.mutation ?? {}, error, attempt);
          if (delayMs === null) throw error;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          attempt += 1;
        }
      }
      if (!generationFence.isCurrent()) return null;
      const payload = data?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);
      const ops = [];
      if (optimistic && (0, _mutationConfiguration.isRespondOptimistic)(optimistic)) {
        ops.push(...planFromRespond(data, operationContext, optimistic, input));
      } else if (optimistic && !(0, _mutationConfiguration.isMethodOptimistic)(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) ops.push(...(0, _internalHandles.getInternalModelHandle)(optimistic.model).planReplace(tempId, node));
      }
      for (const sink of config.extract?.({
        data
      }) ?? []) ops.push(...(0, _internalHandles.getInternalModelHandle)(sink.into).planRows(sink.rows));
      const commitOps = methodPatchOptimistic ? ops.map(op => op.kind === 'upsert' && op.model === optimistic.model.modelId ? {
        ...op,
        operationId
      } : op) : ops;
      if (tracked) {
        if (commitOps.length > 0) {
          (0, _configure.getApplyRuntime)().commit((0, _transaction.createCommitEnvelope)(commitOps, [{
            kind: 'close',
            operationId,
            status: 'committed'
          }]));
        } else {
          operations.close(operationId, 'committed');
        }
      } else if (commitOps.length > 0) {
        (0, _configure.getApplyRuntime)().commit((0, _transaction.createCommitEnvelope)(commitOps));
      }
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      const rollbackOps = [];
      if (optimistic && (0, _mutationConfiguration.isRespondOptimistic)(optimistic) && insertedTempId) {
        if (respondInverse.length > 0) rollbackOps.push(...respondInverse);
      } else if (optimistic && !(0, _mutationConfiguration.isMethodOptimistic)(optimistic) && !(0, _mutationConfiguration.isRespondOptimistic)(optimistic)) {
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
      if (optimistic && (0, _mutationConfiguration.isMethodOptimistic)(optimistic) && optimistic.method === 'patch' && (0, _normalizeHelpers.isRecord)(previous)) {
        const previousRecord = previous;
        const patchValues = optimistic.selectPatch(input);
        const current = optimistic.model.find(optimistic.selectId(input));
        const rowId = String(optimistic.selectId(input));
        const operationsRead = (0, _configure.getOperationState)();
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
      if (optimistic && (0, _mutationConfiguration.isMethodOptimistic)(optimistic) && optimistic.method === 'destroy' && (0, _normalizeHelpers.isRecord)(previous)) {
        rollbackOps.push(...(0, _internalHandles.getInternalModelHandle)(optimistic.model).planRestore(previous, previousMemberships));
      }
      if (tracked) {
        const status = optimistic && !(0, _mutationConfiguration.isMethodOptimistic)(optimistic) && !(0, _mutationConfiguration.isRespondOptimistic)(optimistic) && optimistic.failure !== 'rollback' ? 'failed' : 'rolledback';
        if (rollbackOps.length > 0) {
          (0, _configure.getApplyRuntime)().commit((0, _transaction.createCommitEnvelope)(rollbackOps, [{
            kind: 'close',
            operationId,
            status
          }]));
        } else {
          operations.close(operationId, status);
        }
      }
      (0, _syncError.reportSyncError)(error, {
        source: 'mutation',
        model: optimistic?.model.modelId
      }, 'defineMutation');
      config.onError?.(error, {
        ...operationContext,
        input
      });
      throw error;
    }
    const reportCallbackError = (error, callback) => {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        (0, _logger.getDbLogger)().error('defineMutation post-commit callback failed', {
          callback,
          error: reported
        });
      } catch (loggerError) {
        void loggerError;
      }
      (0, _syncError.reportSyncError)(reported, {
        source: 'mutation',
        model: optimistic?.model.modelId
      }, 'defineMutation');
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
    const input = (0, _configure.getOperationState)().failedFor(optimisticConfig?.model.modelId ?? '', tempId)?.failedInput;
    if (input === undefined || !optimisticConfig || (0, _mutationConfiguration.isMethodOptimistic)(optimisticConfig) || (0, _mutationConfiguration.isRespondOptimistic)(optimisticConfig)) return null;
    clearFailedOptimisticMutation(optimisticConfig.model.modelId, tempId);
    const patch = optimisticConfig.onRetryPatch?.(input);
    if (patch) optimisticConfig.model.update(tempId, patch);
    return runWithTempId(input, tempId);
  };
  const discard = tempId => {
    if (!optimisticConfig || (0, _mutationConfiguration.isMethodOptimistic)(optimisticConfig) || (0, _mutationConfiguration.isRespondOptimistic)(optimisticConfig)) return;
    if (!(0, _configure.getOperationState)().failedFor(optimisticConfig.model.modelId, tempId)) return;
    optimisticConfig.model.destroy(tempId);
    clearFailedOptimisticMutation(optimisticConfig.model.modelId, tempId);
  };
  return {
    run,
    retry,
    discard
  };
};
exports.createMutationRuntime = createMutationRuntime;
//# sourceMappingURL=mutationRuntime.js.map