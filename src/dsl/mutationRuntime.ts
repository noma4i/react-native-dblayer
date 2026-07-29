import type { DefinedMutation, MutationConfig, MutationPayload, MutationRuntimeContext, OperationRecord, OptimisticCtx, WriteOp } from '../types';
import { createCommitEnvelope } from '../core/apply/commitEnvelope';
import { hasDependentCascade } from '../core/relations';
import { noteDataLoss } from '../core/diagnostics';
import { getInternalModelHandle, getInternalScopeHandle } from '../core/internalHandles';
import { getDbLogger } from '../core/logger';
import { serializeOperationInput } from '../core/planes/operationState';
import { retryDelayMs } from '../core/fetch/retryPolicy';
import { responseDataOrThrow } from '../core/transport';
import { generateTempId } from '../utils/generateTempId';
import { isRecord } from '../utils/normalizeHelpers';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { reportSyncError } from '../core/syncError';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState } from './configure';
import { isMethodOptimistic, isRespondOptimistic } from './mutationConfiguration';
import { registerMutationCorrelator } from './mutationCorrelation';
import { createMutationResponder } from './mutationResponder';

/** Internal shared replacement seam for mutation commits and `Model.replace` reconciliation. */
export const clearFailedOptimisticMutation = (model: string, tempId: string): void => {
  const operations = getOperationState();
  const operation = operations.failedFor(model, tempId);
  if (operation) operations.clearFailed(operation.operationId);
};

export const createMutationRuntime = <TData, TInput, TStored extends { id: string }, TNode>(
  config: MutationConfig<TData, TInput, TStored, TNode>,
  definitionId: string
): Pick<DefinedMutation<TData, TInput>, 'run' | 'retry' | 'discard'> => {
  const runtime: MutationRuntimeContext<TData, TInput, TStored, TNode> = { config, optimisticConfig: config.optimistic, ...createMutationResponder(config) };
  if (config.optimistic && !isMethodOptimistic(config.optimistic) && !isRespondOptimistic(config.optimistic) && config.optimistic.correlate) {
    registerMutationCorrelator(config.optimistic.model.modelId, definitionId, config.optimistic.correlate);
  }

  const runWithTempId = async (input: TInput, forcedTempId?: string): Promise<MutationPayload<TData> | null> => {
    const { config, inverseFromRespond, planFromRespond } = runtime;
    const operations = getOperationState();
    const dedupeKey = config.dedupe === false ? undefined : config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (config.once && operations.hasCommitted(dedupeKey)) return null;
      if (operations.hasPending(dedupeKey)) return null;
    }
    const optimistic = config.optimistic;
    const tracked = optimistic != null || dedupeKey != null;
    const operationId = generateTempId('op');
    let tempId: string | null = null;
    let insertedTempId: string | null = null;
    let previous: unknown = null;
    let previousMemberships: Array<{ id: string; scopeKey: string; orderKey: string; edge?: Record<string, unknown> }> = [];
    let respondInverse: WriteOp[] = [];
    let operationContext!: OptimisticCtx;
    let data!: TData;
    let result!: MutationPayload<TData>;
    const methodPatchOptimistic = optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch';
    const persistedFailedInput = optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic) ? serializeOperationInput(input) : null;
    const generationFence = createGenerationFence();

    try {
      if (optimistic && isRespondOptimistic(optimistic)) {
        tempId = generateTempId('row');
        insertedTempId = tempId;
        const fabricated = optimistic.respond(input, { tempId, operationId });
        respondInverse = inverseFromRespond(fabricated, { tempId, operationId }, optimistic);
        const optimisticOps = planFromRespond(fabricated, { tempId, operationId }, optimistic, input);
        const beginFields = {
          operationId,
          model: optimistic.model.modelId,
          tempIds: [tempId],
          rowIds: [tempId],
          intent: 'insert' as const,
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          createdAt: Date.now()
        };
        if (optimisticOps.length > 0) {
          getApplyRuntime().commit(createCommitEnvelope(optimisticOps, [{ kind: 'begin', operation: beginFields }]));
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
            ...(persistedFailedInput?.serializable ? { failedInput: persistedFailedInput.value } : {}),
            createdAt: Date.now()
          });
        } else {
          const newTempId = generateTempId(optimistic.tempIdPrefix ?? 'row');
          tempId = newTempId;
          insertedTempId = newTempId;
          const row = optimistic.build(input, { tempId: newTempId, operationId });
          const placement = optimistic.prependTo ?? optimistic.appendTo;
          const position = optimistic.prependTo ? 'prepend' : 'append';
          const ops = getInternalModelHandle(optimistic.model).planRows([{ ...(row as Record<string, unknown>), id: newTempId }]);
          if (placement) ops.push(...getInternalScopeHandle(placement.scope).planPlacement(placement.value(input), newTempId, position));
          const beginFields: Omit<OperationRecord, 'status'> = {
            operationId,
            model: optimistic.model.modelId,
            tempIds: [newTempId],
            rowIds: [newTempId],
            intent: 'insert',
            idempotencyKey: dedupeKey ?? operationId,
            once: config.once === true,
            ...(persistedFailedInput?.serializable ? { failedInput: persistedFailedInput.value } : {}),
            createdAt: Date.now()
          };
          getApplyRuntime().commit(createCommitEnvelope(ops, [{ kind: 'begin', operation: beginFields }]));
        }
      } else if (optimistic && optimistic.method === 'patch') {
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        const patch = optimistic.selectPatch(input) as Record<string, unknown>;
        const beginFields: Omit<OperationRecord, 'status'> = {
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
        getApplyRuntime().commit(
          createCommitEnvelope([{ kind: 'patch', model: optimistic.model.modelId, id: String(id), patch, operationId }], [{ kind: 'begin', operation: beginFields }])
        );
      } else if (optimistic && optimistic.method === 'destroy') {
        if (hasDependentCascade(optimistic.model.modelId)) {
          throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
        }
        const id = optimistic.selectId(input);
        previous = optimistic.model.find(id);
        previousMemberships = getInternalModelHandle(optimistic.model).captureMembership(id);
        const beginFields: Omit<OperationRecord, 'status'> = {
          operationId,
          model: optimistic.model.modelId,
          tempIds: [],
          rowIds: [String(id)],
          intent: 'destroy',
          idempotencyKey: dedupeKey ?? operationId,
          once: config.once === true,
          createdAt: Date.now()
        };
        getApplyRuntime().commit(
          createCommitEnvelope([{ kind: 'destroy', model: optimistic.model.modelId, ids: [String(id)] }], [{ kind: 'begin', operation: beginFields }])
        );
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
      operationContext = { tempId, operationId };
      config.onMutate?.(input, operationContext);

      let attempt = 1;
      while (true) {
        if (!generationFence.isCurrent()) return null;
        try {
          data = responseDataOrThrow(await getDbRuntimeConfig().transport.mutation({ mutation: config.document, variables: { input: config.mapInput?.(input, operationContext) ?? input } }));
          break;
        } catch (error) {
          if (!generationFence.isCurrent()) return null;
          const delayMs = retryDelayMs(getDbRuntimeConfig().defaults.retry?.mutation ?? {}, error, attempt);
          if (delayMs === null) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, delayMs));
          attempt += 1;
        }
      }
      if (!generationFence.isCurrent()) return null;
      const payload = (data as Record<string, unknown> | null | undefined)?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);
      result = payload as MutationPayload<TData>;

      const ops: WriteOp[] = [];
      if (optimistic && isRespondOptimistic(optimistic)) {
        ops.push(...planFromRespond(data, operationContext, optimistic, input));
      } else if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) ops.push(...getInternalModelHandle(optimistic.model).planReplace(tempId, node));
      }
      for (const sink of config.extract?.({ data }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
      const commitOps = methodPatchOptimistic
        ? ops.map(op => (op.kind === 'upsert' && op.model === optimistic.model.modelId ? { ...op, operationId } : op))
        : ops;
      if (tracked) {
        if (commitOps.length > 0) {
          getApplyRuntime().commit(
            createCommitEnvelope(commitOps, [{ kind: 'close', operationId, status: 'committed' }])
          );
        } else {
          operations.close(operationId, 'committed');
        }
      } else if (commitOps.length > 0) {
        getApplyRuntime().commit(createCommitEnvelope(commitOps));
      }
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      const rollbackOps: WriteOp[] = [];
      if (optimistic && isRespondOptimistic(optimistic) && insertedTempId) {
        if (respondInverse.length > 0) rollbackOps.push(...respondInverse);
      } else if (optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic)) {
        if (optimistic.failure === 'rollback') {
          if (insertedTempId) rollbackOps.push({ kind: 'destroy', model: optimistic.model.modelId, ids: [insertedTempId], tombstone: false });
        } else if (tempId) {
          const patch = optimistic.onFailurePatch?.(input);
          if (patch) rollbackOps.push({ kind: 'patch', model: optimistic.model.modelId, id: tempId, patch: patch as Record<string, unknown> });
        }
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && isRecord(previous)) {
        const previousRecord = previous as Record<string, unknown>;
        const patchValues = optimistic.selectPatch(input) as Record<string, unknown>;
        const current = optimistic.model.find(optimistic.selectId(input)) as Record<string, unknown> | undefined;
        const rowId = String(optimistic.selectId(input));
        const operationsRead = getOperationState();
        const restore: Record<string, unknown> = {};
        for (const key of Object.keys(patchValues)) {
          const other = operationsRead.latestPendingValue(optimistic.model.modelId, rowId, key, operationId);
          if (other.found) {
            restore[key] = other.value;
            continue;
          }
          if (current && !Object.is(current[key], patchValues[key])) continue;
          restore[key] = key in previousRecord ? previousRecord[key] : undefined;
        }
        if (Object.keys(restore).length > 0) rollbackOps.push({ kind: 'patch', model: optimistic.model.modelId, id: rowId, patch: restore, operationId });
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && isRecord(previous)) {
        rollbackOps.push(...getInternalModelHandle(optimistic.model).planRestore(previous, previousMemberships));
      }
      if (tracked) {
        const status = optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic) && optimistic.failure !== 'rollback' ? 'failed' : 'rolledback';
        if (rollbackOps.length > 0) {
          getApplyRuntime().commit(
            createCommitEnvelope(rollbackOps, [{ kind: 'close', operationId, status }])
          );
        } else {
          operations.close(operationId, status);
        }
      }
      reportSyncError(error, { source: 'mutation', model: optimistic?.model.modelId }, 'defineMutation');
      config.onError?.(error as Error, { ...operationContext, input });
      throw error;
    }
    const reportCallbackError = (error: unknown, callback: string): void => {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbLogger().error('defineMutation post-commit callback failed', { callback, error: reported });
      } catch (loggerError) {
        void loggerError;
      }
      reportSyncError(reported, { source: 'mutation', model: optimistic?.model.modelId }, 'defineMutation');
    };
    const runCommittedCallback = (callback: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        reportCallbackError(error, callback);
      }
    };
    runCommittedCallback('onCommit', () => config.onCommit?.(data, { ...operationContext, input }));
    runCommittedCallback('invalidate', () => config.invalidate?.({ input, data }));
    runCommittedCallback('track', () => config.track?.({ input, data }));
    return result;
  };

  const optimisticConfig = runtime.optimisticConfig;
  const run = (input: TInput): Promise<MutationPayload<TData> | null> => runWithTempId(input);
  const retry = async (tempId: string): Promise<MutationPayload<TData> | null> => {
    const input = getOperationState().failedFor(optimisticConfig?.model.modelId ?? '', tempId)?.failedInput as TInput | undefined;
    if (input === undefined || !optimisticConfig || isMethodOptimistic(optimisticConfig) || isRespondOptimistic(optimisticConfig)) return null;
    clearFailedOptimisticMutation(optimisticConfig.model.modelId, tempId);
    const patch = optimisticConfig.onRetryPatch?.(input);
    if (patch) optimisticConfig.model.update(tempId, patch as Record<string, unknown>);
    return runWithTempId(input, tempId);
  };
  const discard = (tempId: string): void => {
    if (!optimisticConfig || isMethodOptimistic(optimisticConfig) || isRespondOptimistic(optimisticConfig)) return;
    if (!getOperationState().failedFor(optimisticConfig.model.modelId, tempId)) return;
    optimisticConfig.model.destroy(tempId);
    clearFailedOptimisticMutation(optimisticConfig.model.modelId, tempId);
  };

  return { run, retry, discard };
};
