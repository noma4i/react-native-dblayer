"use strict";

import { createCommitEnvelope } from "../core/apply/commitEnvelope.js";
import { noteDataLoss } from "../core/diagnostics.js";
import { getInternalModelHandle } from "../core/internalHandles.js";
import { serializeOperationInput } from "../core/planes/operationState.js";
import { generateTempId } from "../utils/generateTempId.js";
import { getApplyRuntime, getOperationState, getRuntimeGeneration } from "./configure.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { reportSyncError } from "../core/syncError.js";
const declarations = new Map();
const reportFailure = (error, model) => {
  reportSyncError(error, {
    source: 'detached',
    model
  }, 'defineDetachedOperation');
};

/** Define one durable operation whose executor is owned by the consumer and resumed by core at boot. */
export const defineDetachedOperation = (model, kind, config) => {
  const generation = getRuntimeGeneration();
  const existing = declarations.get(kind);
  if (existing && existing.generation === generation) throw new Error(`Detached operation kind already registered: ${kind}`);
  if (getInternalModelHandle(model).dropTempRowsAfterMs() === undefined) throw new Error(`${model.modelId} must declare maintenance.dropTempRowsAfterMs to be used in a detached operation`);
  const failRecord = (record, error) => {
    if (record.status !== 'pending') return;
    const input = record.failedInput;
    if (config.failure === 'rollback') {
      getApplyRuntime().commit(createCommitEnvelope([{
        kind: 'destroy',
        model: model.modelId,
        ids: record.tempIds,
        tombstone: false
      }], [{
        kind: 'close',
        operationId: record.operationId,
        status: 'rolledback'
      }]));
      noteDataLoss('detached-operation-rollback', model.modelId, record.tempIds.length);
    } else {
      const patch = input === undefined ? undefined : config.onFailurePatch?.(input);
      if (patch && record.tempIds[0]) {
        getApplyRuntime().commit(createCommitEnvelope([{
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
        getOperationState().close(record.operationId, 'failed');
      }
    }
    reportFailure(error, model.modelId);
  };
  const resumeRecord = async (record, generation = getRuntimeGeneration()) => {
    const generationFence = createGenerationFence({
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
      noteDataLoss('detached-resume-error', model.modelId, 1);
      failRecord(record, error instanceof Error ? error : new Error(String(error)));
      return 'orphaned';
    }
  };
  const handle = {
    start: input => {
      const operationId = generateTempId('op');
      const tempId = generateTempId('row');
      const serialized = serializeOperationInput(input);
      const row = {
        ...config.build(input, {
          operationId,
          tempId
        }),
        id: tempId
      };
      const ops = getInternalModelHandle(model).planRows([row]);
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
      if (!serialized.serializable) noteDataLoss('failed-input-unserializable', model.modelId, 1);
      getApplyRuntime().commit(createCommitEnvelope(ops, [{
        kind: 'begin',
        operation: beginFields
      }]));
      return {
        operationId,
        tempId
      };
    },
    complete: (operationId, serverNode) => {
      const operation = getOperationState().get(operationId);
      if (!operation || operation.kind !== kind || operation.status !== 'pending' || !operation.tempIds[0]) return;
      const ops = getInternalModelHandle(model).planReplace(operation.tempIds[0], serverNode);
      getApplyRuntime().commit(createCommitEnvelope(ops, [{
        kind: 'close',
        operationId,
        status: 'committed'
      }]));
    },
    fail: (operationId, error) => {
      const operation = getOperationState().get(operationId);
      if (!operation || operation.kind !== kind) return;
      failRecord(operation, error);
    },
    retry: async operationId => {
      const current = getOperationState().get(operationId);
      if (!current || current.kind !== kind || current.status !== 'failed' || current.failedInput === undefined) return null;
      return resumeRecord(getOperationState().reopen(operationId));
    },
    discard: operationId => {
      const operation = getOperationState().get(operationId);
      if (!operation || operation.kind !== kind) return;
      if (operation.tempIds.length > 0) {
        getApplyRuntime().commit(createCommitEnvelope([{
          kind: 'destroy',
          model: model.modelId,
          ids: operation.tempIds,
          tombstone: false
        }], [{
          kind: 'remove',
          operationId
        }]));
      } else {
        getOperationState().remove(operationId);
      }
      noteDataLoss('detached-operation-discard', model.modelId, operation.tempIds.length);
    }
  };
  declarations.set(kind, {
    generation,
    resume: async (record, resumeGeneration) => void (await resumeRecord(record, resumeGeneration))
  });
  return handle;
};

/** Invoke every hydrated detached declaration once before startup GC and pending-TTL maintenance. */
export const reconcileDetachedOperationsAtBoot = async generation => {
  const generationFence = createGenerationFence({
    generation
  });
  if (!generationFence.isCurrent()) return;
  const pending = getOperationState().hydratedPending().filter(record => record.kind !== undefined);
  for (const record of pending) {
    if (!declarations.has(record.kind)) throw new Error(`No detached operation declaration registered for ${record.kind}`);
  }
  for (const record of getOperationState().takeHydratedPending(record => record.kind !== undefined)) {
    await declarations.get(record.kind).resume(record, generation);
    if (!generationFence.isCurrent()) return;
  }
};
//# sourceMappingURL=defineDetachedOperation.js.map