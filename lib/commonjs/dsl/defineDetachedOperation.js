"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.reconcileDetachedOperationsAtBoot = exports.defineDetachedOperation = void 0;
var _commitEnvelope = require("../core/apply/commitEnvelope.js");
var _diagnostics = require("../core/diagnostics.js");
var _internalHandles = require("../core/internalHandles.js");
var _operationState = require("../core/planes/operationState.js");
var _generateTempId = require("../utils/generateTempId.js");
var _configure = require("./configure.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _syncError = require("../core/syncError.js");
const declarations = new Map();
const reportFailure = (error, model) => {
  (0, _syncError.reportSyncError)(error, {
    source: 'detached',
    model
  }, 'defineDetachedOperation');
};

/** Define one durable operation whose executor is owned by the consumer and resumed by core at boot. */
const defineDetachedOperation = (model, kind, config) => {
  const generation = (0, _configure.getRuntimeGeneration)();
  const existing = declarations.get(kind);
  if (existing && existing.generation === generation) throw new Error(`Detached operation kind already registered: ${kind}`);
  if ((0, _internalHandles.getInternalModelHandle)(model).dropTempRowsAfterMs() === undefined) throw new Error(`${model.modelId} must declare maintenance.dropTempRowsAfterMs to be used in a detached operation`);
  const failRecord = (record, error) => {
    if (record.status !== 'pending') return;
    const input = record.failedInput;
    if (config.failure === 'rollback') {
      (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
        kind: 'destroy',
        model: model.modelId,
        ids: record.tempIds,
        tombstone: false
      }], [{
        kind: 'close',
        operationId: record.operationId,
        status: 'rolledback'
      }]));
      (0, _diagnostics.noteDataLoss)('detached-operation-rollback', model.modelId, record.tempIds.length);
    } else {
      const patch = input === undefined ? undefined : config.onFailurePatch?.(input);
      if (patch && record.tempIds[0]) {
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
          kind: 'patch',
          model: model.modelId,
          id: record.tempIds[0],
          patch
        }], [{
          kind: 'close',
          operationId: record.operationId,
          status: 'failed'
        }]));
      } else {
        (0, _configure.getOperationState)().close(record.operationId, 'failed');
      }
    }
    reportFailure(error, model.modelId);
  };
  const resumeRecord = async (record, generation = (0, _configure.getRuntimeGeneration)()) => {
    const generationFence = (0, _runtimeGeneration.createGenerationFence)({
      generation
    });
    const tempId = record.tempIds[0];
    const input = record.failedInput;
    if (!tempId || input === undefined) {
      failRecord(record, new Error(`Detached operation ${record.operationId} has no serializable input`));
      return 'orphaned';
    }
    try {
      const outcome = await config.resume({
        operationId: record.operationId,
        tempId,
        input
      });
      if (!generationFence.isCurrent()) return 'continue';
      if (outcome === 'orphaned') failRecord(record, new Error(`Detached operation ${record.operationId} is orphaned`));
      return outcome;
    } catch (error) {
      if (!generationFence.isCurrent()) return 'continue';
      (0, _diagnostics.noteDataLoss)('detached-resume-error', model.modelId, 1);
      failRecord(record, error instanceof Error ? error : new Error(String(error)));
      return 'orphaned';
    }
  };
  const handle = {
    start: input => {
      const operationId = (0, _generateTempId.generateTempId)('op');
      const tempId = (0, _generateTempId.generateTempId)('row');
      const serialized = (0, _operationState.serializeOperationInput)(input);
      const row = {
        ...config.build(input, {
          tempId
        }),
        id: tempId
      };
      const ops = (0, _internalHandles.getInternalModelHandle)(model).planRows([row]);
      const beginFields = {
        operationId,
        kind,
        model: model.modelId,
        tempIds: [tempId],
        rowIds: [tempId],
        intent: 'insert',
        ...(serialized.serializable ? {
          failedInput: serialized.value
        } : {}),
        createdAt: Date.now()
      };
      if (!serialized.serializable) (0, _diagnostics.noteDataLoss)('failed-input-unserializable', model.modelId, 1);
      (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(ops, [{
        kind: 'begin',
        operation: beginFields
      }]));
      return {
        operationId,
        tempId
      };
    },
    complete: (operationId, serverNode) => {
      const operation = (0, _configure.getOperationState)().get(operationId);
      if (!operation || operation.kind !== kind || operation.status !== 'pending' || !operation.tempIds[0]) return;
      const ops = (0, _internalHandles.getInternalModelHandle)(model).planReplace(operation.tempIds[0], serverNode);
      (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(ops, [{
        kind: 'close',
        operationId,
        status: 'committed'
      }]));
    },
    fail: (operationId, error) => {
      const operation = (0, _configure.getOperationState)().get(operationId);
      if (!operation || operation.kind !== kind) return;
      failRecord(operation, error);
    },
    retry: async operationId => {
      const current = (0, _configure.getOperationState)().get(operationId);
      if (!current || current.kind !== kind || current.status !== 'failed' || current.failedInput === undefined) return null;
      const record = (0, _configure.getOperationState)().reopen(operationId);
      if (!record) return null;
      return resumeRecord(record);
    },
    discard: operationId => {
      const operation = (0, _configure.getOperationState)().get(operationId);
      if (!operation || operation.kind !== kind) return;
      if (operation.tempIds.length > 0) {
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
          kind: 'destroy',
          model: model.modelId,
          ids: operation.tempIds,
          tombstone: false
        }], [{
          kind: 'remove',
          operationId
        }]));
      } else {
        (0, _configure.getOperationState)().remove(operationId);
      }
      (0, _diagnostics.noteDataLoss)('detached-operation-discard', model.modelId, operation.tempIds.length);
    }
  };
  declarations.set(kind, {
    generation,
    resume: async (record, resumeGeneration) => void (await resumeRecord(record, resumeGeneration))
  });
  return handle;
};

/** Invoke every hydrated detached declaration once before startup GC and pending-TTL maintenance. */
exports.defineDetachedOperation = defineDetachedOperation;
const reconcileDetachedOperationsAtBoot = async (generation = (0, _configure.getRuntimeGeneration)()) => {
  const generationFence = (0, _runtimeGeneration.createGenerationFence)({
    generation
  });
  if (!generationFence.isCurrent()) return;
  const pending = (0, _configure.getOperationState)().hydratedPending().filter(record => record.kind !== undefined);
  for (const record of pending) {
    if (!declarations.has(record.kind)) throw new Error(`No detached operation declaration registered for ${record.kind}`);
  }
  for (const record of (0, _configure.getOperationState)().takeHydratedPending(record => record.kind !== undefined)) {
    if (!generationFence.isCurrent()) return;
    await declarations.get(record.kind).resume(record, generation);
    if (!generationFence.isCurrent()) return;
  }
};
exports.reconcileDetachedOperationsAtBoot = reconcileDetachedOperationsAtBoot;
//# sourceMappingURL=defineDetachedOperation.js.map