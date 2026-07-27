import type { JournalOp } from '../core/apply/journal';
import { noteDataLoss } from '../core/diagnostics';
import { getInternalModelHandle } from '../core/internalHandles';
import { serializeOperationInput, type OperationRecord } from '../core/planes/operationState';
import { generateTempId } from '../utils/generateTempId';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState, getRuntimeGeneration } from './configure';

type DetachedModel<TStored extends { id: string }> = {
  modelId: string;
  update(id: string, patch: Partial<TStored>): void;
};

export type DetachedOperationConfig<TInput, TStored extends { id: string }> = {
  build: (input: TInput, ctx: { tempId: string }) => Omit<TStored, 'id'> | TStored;
  resume: (entry: { operationId: string; tempId: string; input: TInput }) => Promise<'continue' | 'orphaned'>;
  failure?: 'rollback' | 'keep';
  onFailurePatch?: (input: TInput) => Partial<TStored>;
};

export type DetachedOperationHandle<TInput, TStored extends { id: string }> = {
  start(input: TInput): { operationId: string; tempId: string };
  complete(operationId: string, serverNode: unknown): void;
  fail(operationId: string, error: Error): void;
  retry(operationId: string): Promise<'continue' | 'orphaned' | null>;
  discard(operationId: string): void;
};

type Declaration = {
  generation: number;
  resume(record: OperationRecord): Promise<void>;
};

const declarations = new Map<string, Declaration>();

const reportFailure = (error: Error, model: string): void => {
  try {
    getDbRuntimeConfig().defaults?.onSyncError?.(error, { source: 'detached', model });
  } catch {
    // An error observer cannot change the terminal state of a detached operation.
  }
};

/** Define one durable operation whose executor is owned by the consumer and resumed by core at boot. */
export const defineDetachedOperation = <TInput, TStored extends { id: string }>(
  model: DetachedModel<TStored>,
  kind: string,
  config: DetachedOperationConfig<TInput, TStored>
): DetachedOperationHandle<TInput, TStored> => {
  const generation = getRuntimeGeneration();
  const existing = declarations.get(kind);
  if (existing && existing.generation === generation) throw new Error(`Detached operation kind already registered: ${kind}`);
  if (getInternalModelHandle(model).dropTempRowsAfterMs() === undefined)
    throw new Error(`${model.modelId} must declare maintenance.dropTempRowsAfterMs to be used in a detached operation`);

  const failRecord = (record: OperationRecord, error: Error): void => {
    if (record.status !== 'pending') return;
    const input = record.failedInput as TInput | undefined;
    if (config.failure === 'rollback') {
      getApplyRuntime().apply([{ kind: 'destroy', model: model.modelId, ids: record.tempIds, tombstone: false }]);
      getOperationState().close(record.operationId, 'rolledback');
      noteDataLoss('detached-operation-rollback', model.modelId, record.tempIds.length);
    } else {
      const patch = input === undefined ? undefined : config.onFailurePatch?.(input);
      if (patch && record.tempIds[0]) model.update(record.tempIds[0], patch);
      getOperationState().close(record.operationId, 'failed');
    }
    reportFailure(error, model.modelId);
  };

  const resumeRecord = async (record: OperationRecord): Promise<'continue' | 'orphaned'> => {
    const tempId = record.tempIds[0];
    const input = record.failedInput as TInput | undefined;
    if (!tempId || input === undefined) {
      failRecord(record, new Error(`Detached operation ${record.operationId} has no serializable input`));
      return 'orphaned';
    }
    try {
      const outcome = await config.resume({ operationId: record.operationId, tempId, input });
      if (outcome === 'orphaned') failRecord(record, new Error(`Detached operation ${record.operationId} is orphaned`));
      return outcome;
    } catch (error) {
      noteDataLoss('detached-resume-error', model.modelId, 1);
      failRecord(record, error instanceof Error ? error : new Error(String(error)));
      return 'orphaned';
    }
  };

  const handle: DetachedOperationHandle<TInput, TStored> = {
    start: input => {
      const operationId = generateTempId('op');
      const tempId = generateTempId('row');
      const serialized = serializeOperationInput(input);
      const row = { ...(config.build(input, { tempId }) as Record<string, unknown>), id: tempId };
      const ops: JournalOp[] = getInternalModelHandle(model).planRows([row]);
      const operations = getOperationState();
      operations.begin({
        operationId,
        kind,
        model: model.modelId,
        tempIds: [tempId],
        rowIds: [tempId],
        intent: 'insert',
        ...(serialized.serializable ? { failedInput: serialized.value } : {}),
        createdAt: Date.now()
      }, { persist: false });
      if (!serialized.serializable) noteDataLoss('failed-input-unserializable', model.modelId, 1);
      getApplyRuntime().apply(ops, { extraEntries: () => operations.persistEntries() });
      return { operationId, tempId };
    },
    complete: (operationId, serverNode) => {
      const operation = getOperationState().get(operationId);
      if (!operation || operation.kind !== kind || operation.status !== 'pending' || !operation.tempIds[0]) return;
      getApplyRuntime().apply(getInternalModelHandle(model).planReplace(operation.tempIds[0], serverNode));
      getOperationState().close(operationId, 'committed');
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
      if (operation.tempIds.length > 0) getApplyRuntime().apply([{ kind: 'destroy', model: model.modelId, ids: operation.tempIds, tombstone: false }]);
      getOperationState().remove(operationId);
      noteDataLoss('detached-operation-discard', model.modelId, operation.tempIds.length);
    }
  };

  declarations.set(kind, { generation, resume: async record => void (await resumeRecord(record)) });
  return handle;
};

/** Invoke every hydrated detached declaration once before startup GC and pending-TTL maintenance. */
export const reconcileDetachedOperationsAtBoot = async (): Promise<void> => {
  const pending = getOperationState().hydratedPending().filter(record => record.kind !== undefined);
  for (const record of pending) {
    if (!declarations.has(record.kind!)) throw new Error(`No detached operation declaration registered for ${record.kind}`);
  }
  for (const record of getOperationState().takeHydratedPending(record => record.kind !== undefined)) {
    await declarations.get(record.kind!)!.resume(record);
  }
};
