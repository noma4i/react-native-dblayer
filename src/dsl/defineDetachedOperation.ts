import type { DetachedDeclaration, DetachedModel, DetachedOperationConfig, DetachedOperationHandle, OperationRecord, WriteOp } from '../types';
import { createCommitEnvelope } from '../core/apply/transaction';
import { noteDataLoss } from '../core/diagnostics';
import { getInternalModelHandle } from '../core/internalHandles';
import { serializeOperationInput } from '../core/planes/operationState';
import { generateTempId } from '../utils/generateTempId';
import { getApplyRuntime, getOperationState, getRuntimeGeneration } from './configure';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { reportSyncError } from '../core/syncError';

const declarations = new Map<string, DetachedDeclaration>();

const reportFailure = (error: Error, model: string): void => {
  reportSyncError(error, { source: 'detached', model }, 'defineDetachedOperation');
};

/** Define one durable operation whose executor is owned by the consumer and resumed by core at boot. */
export const defineDetachedOperation = <TInput, TStored extends { id: string }>(
  model: DetachedModel<TStored>,
  kind: string,
  config: DetachedOperationConfig<TInput, TStored>
): DetachedOperationHandle<TInput> => {
  const generation = getRuntimeGeneration();
  const existing = declarations.get(kind);
  if (existing && existing.generation === generation) throw new Error(`Detached operation kind already registered: ${kind}`);
  if (getInternalModelHandle(model).dropTempRowsAfterMs() === undefined)
    throw new Error(`${model.modelId} must declare maintenance.dropTempRowsAfterMs to be used in a detached operation`);

  const failRecord = (record: OperationRecord, error: Error): void => {
    if (record.status !== 'pending') return;
    const input = record.failedInput as TInput | undefined;
    if (config.failure === 'rollback') {
      getApplyRuntime().commit(
        createCommitEnvelope(
          [{ kind: 'destroy', model: model.modelId, ids: record.tempIds, tombstone: false }],
          [{ kind: 'close', operationId: record.operationId, status: 'rolledback' }]
        )
      );
      noteDataLoss('detached-operation-rollback', model.modelId, record.tempIds.length);
    } else {
      const patch = input === undefined ? undefined : config.onFailurePatch?.(input);
      if (patch && record.tempIds[0]) {
        getApplyRuntime().commit(
          createCommitEnvelope(
            [{ kind: 'patch', model: model.modelId, id: record.tempIds[0], patch }],
            [{ kind: 'close', operationId: record.operationId, status: 'failed' }]
          )
        );
      } else {
        getOperationState().close(record.operationId, 'failed');
      }
    }
    reportFailure(error, model.modelId);
  };

  const resumeRecord = async (record: OperationRecord, generation = getRuntimeGeneration()): Promise<'continue' | 'orphaned'> => {
    const generationFence = createGenerationFence({ generation });
    const tempId = record.tempIds[0];
    const input = record.failedInput as TInput | undefined;
    if (!tempId || input === undefined) {
      failRecord(record, new Error(`Detached operation ${record.operationId} has no serializable input`));
      return 'orphaned';
    }
    try {
      const outcome = await config.resume({ operationId: record.operationId, tempId, input });
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

  const handle: DetachedOperationHandle<TInput> = {
    start: input => {
      const operationId = generateTempId('op');
      const tempId = generateTempId('row');
      const serialized = serializeOperationInput(input);
      const row = { ...(config.build(input, { tempId }) as Record<string, unknown>), id: tempId };
      const ops: WriteOp[] = getInternalModelHandle(model).planRows([row]);
      const beginFields: Omit<OperationRecord, 'status'> = {
        operationId,
        kind,
        model: model.modelId,
        tempIds: [tempId],
        rowIds: [tempId],
        intent: 'insert',
        ...(serialized.serializable ? { failedInput: serialized.value } : {}),
        createdAt: Date.now()
      };
      if (!serialized.serializable) noteDataLoss('failed-input-unserializable', model.modelId, 1);
      getApplyRuntime().commit(createCommitEnvelope(ops, [{ kind: 'begin', operation: beginFields }]));
      return { operationId, tempId };
    },
    complete: (operationId, serverNode) => {
      const operation = getOperationState().get(operationId);
      if (!operation || operation.kind !== kind || operation.status !== 'pending' || !operation.tempIds[0]) return;
      const ops = getInternalModelHandle(model).planReplace(operation.tempIds[0], serverNode);
      getApplyRuntime().commit(
        createCommitEnvelope(ops, [{ kind: 'close', operationId, status: 'committed' }])
      );
    },
    fail: (operationId, error) => {
      const operation = getOperationState().get(operationId);
      if (!operation || operation.kind !== kind) return;
      failRecord(operation, error);
    },
    retry: async operationId => {
      const current = getOperationState().get(operationId);
      if (!current || current.kind !== kind || current.status !== 'failed' || current.failedInput === undefined) return null;
      const record = getOperationState().reopen(operationId);
      if (!record) return null;
      return resumeRecord(record);
    },
    discard: operationId => {
      const operation = getOperationState().get(operationId);
      if (!operation || operation.kind !== kind) return;
      if (operation.tempIds.length > 0) {
        getApplyRuntime().commit(
          createCommitEnvelope(
            [{ kind: 'destroy', model: model.modelId, ids: operation.tempIds, tombstone: false }],
            [{ kind: 'remove', operationId }]
          )
        );
      } else {
        getOperationState().remove(operationId);
      }
      noteDataLoss('detached-operation-discard', model.modelId, operation.tempIds.length);
    }
  };

  declarations.set(kind, { generation, resume: async (record, resumeGeneration) => void (await resumeRecord(record, resumeGeneration)) });
  return handle;
};

/** Invoke every hydrated detached declaration once before startup GC and pending-TTL maintenance. */
export const reconcileDetachedOperationsAtBoot = async (generation = getRuntimeGeneration()): Promise<void> => {
  const generationFence = createGenerationFence({ generation });
  if (!generationFence.isCurrent()) return;
  const pending = getOperationState().hydratedPending().filter(record => record.kind !== undefined);
  for (const record of pending) {
    if (!declarations.has(record.kind!)) throw new Error(`No detached operation declaration registered for ${record.kind}`);
  }
  for (const record of getOperationState().takeHydratedPending(record => record.kind !== undefined)) {
    if (!generationFence.isCurrent()) return;
    await declarations.get(record.kind!)!.resume(record, generation);
    if (!generationFence.isCurrent()) return;
  }
};
