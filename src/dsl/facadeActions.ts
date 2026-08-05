import type {
  ActionInput,
  ActionDefinitionData,
  ActionPayload,
  ActionRequestDefinition,
  ActionRequestPlan,
  DurableActionHandle,
  DurableActionTransportInput,
  FacadeRuntimeModel,
  GraphqlActionDefinition,
  GraphqlActionDurableDefinition,
  ModelActionMethods,
  OperationRecord,
  RowOperation
} from '../types';
import { readRowOperationState, useRowOperationState } from './rowOperationState';
import { getInternalModelHandle } from '../core/internalHandles';
import { hasDependentCascade } from '../core/relations';
import { compileModelRootPlan, modelRootIntentOf } from './modelRootPlan';
import { registerMutationCorrelator } from './mutationCorrelation';
import { createCommitEnvelope } from '../core/apply/commitEnvelope';
import { getApplyRuntime, getOperationState, getRuntimeGeneration } from './configure';
import { getDbTransport, responseDataOrThrow } from '../core/transport';
import { reportSyncError } from '../core/syncError';
import { serializeOperationInput } from '../core/planes/operationState';
import { generateTempId } from '../utils/generateTempId';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { isNonArrayRecord } from '../utils/normalizeHelpers';
import { useActionHandle } from './actionHook';
import { createWritePlanCollector, runWritePlanInvalidations, stampCausalRevision } from './writePlan';
import { planRequestFailureRollback } from '../core/requestRollback';
import { compositeKey } from '../core/serialize';
import { MutationDeliveryUnknownError } from '../core/mutationDeliveryError';

/**
 * A declared action becomes its runtime handle here. The declared mode decides which action lifecycle
 * carries it - a durable operation or a request - and the caller sees one handle either
 * way, so a consumer never reproduces the lifecycle of the mode it happened to get.
 */
export const createOperation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  id: string | null | undefined
): RowOperation<TStored> => ({
  read: () => readRowOperationState<TStored>(runtime.modelId, id),
  use: () => useRowOperationState<TStored>(runtime.modelId, id)
});

export const createAction = <TStored extends { id: string; updatedAt?: string | null }, TInput, TDefinition extends GraphqlActionDefinition<any, any, any, any, any>>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  name: string,
  definition: TDefinition
): ModelActionMethods<Record<'defined', TDefinition>>['defined'] => {
  const rootOwner = {
    modelId: runtime.modelId,
    planRows: (rows: readonly unknown[], options?: { origin?: 'event' }) => getInternalModelHandle(runtime).planRows([...rows], options ?? { origin: 'event' })
  };
  const selectOneRow = (value: unknown, selector: string): Record<string, unknown> => {
    if (!isNonArrayRecord(value)) throw new Error(`${name}: ${selector} selector must return exactly one row`);
    return value;
  };
  /** Optimistic-insert plan owner: exactly one selected row, planned through the landing graph,
   * which throws on guard/id rejection before the ledger and transport ever start. */
  const createOptimisticInsertOwner = (insertTempId: string) => ({
    modelId: runtime.modelId,
    planRows: (rows: readonly unknown[], _options?: { origin?: 'event' }) => {
      if (rows.length !== 1) throw new Error(`${name}: optimistic insert selector must return exactly one row`);
      const row = selectOneRow(rows[0], 'optimistic insert');
      return rootOwner.planRows([{ ...row, id: insertTempId }]);
    }
  });
  const actionKey = name;
  const reportCallbackError = (error: unknown, callback: string): void => {
    reportSyncError(error, { source: 'action', model: runtime.modelId, key: callback }, 'modelAction');
  };
  if (definition.mode === 'durable') {
    const durableDefinition = definition as GraphqlActionDurableDefinition<
      ActionDefinitionData<TDefinition>,
      any,
      ActionInput<TDefinition>,
      keyof ActionDefinitionData<TDefinition> & string,
      DurableActionTransportInput<TDefinition>,
      string,
      unknown,
      TStored
    >;
    const correlate = durableDefinition.optimistic.correlate;
    if (correlate) registerMutationCorrelator(runtime.modelId, actionKey, correlate);
    const executions = new Map<string, Promise<ActionPayload<TDefinition> | null>>();
    const currentRecord = (operationId: string, tempId: string): OperationRecord | undefined => {
      const record = getOperationState().get(operationId);
      if (
        !record ||
        record.actionMode !== 'durable' ||
        record.actionKey !== actionKey ||
        record.model !== runtime.modelId ||
        record.intent !== 'insert' ||
        (record.status !== 'pending' && record.status !== 'failed' && record.status !== 'delivery_unknown') ||
        record.tempIds.length !== 1 ||
        record.tempIds[0] !== tempId ||
        !Object.hasOwn(record, 'input') ||
        record.input === undefined
      ) {
        return undefined;
      }
      return record;
    };
    const createHandle = (operationId: string, tempId: string): DurableActionHandle<DurableActionTransportInput<TDefinition>, ActionPayload<TDefinition>> => {
      const execute = (transportInput: DurableActionTransportInput<TDefinition>): Promise<ActionPayload<TDefinition> | null> => {
        const record = currentRecord(operationId, tempId);
        if (!record) return Promise.resolve(null);
        if (record.status === 'delivery_unknown') return Promise.resolve(null);
        const existing = executions.get(operationId);
        if (existing) return existing;
        const execution = runExecution(record, tempId, transportInput);
        const promise = execution.then(
          value => {
            if (executions.get(operationId) === promise) executions.delete(operationId);
            return value;
          },
          error => {
            if (executions.get(operationId) === promise) executions.delete(operationId);
            throw error;
          }
        );
        executions.set(operationId, promise);
        return promise;
      };
      const cancel = (): void => {
        const record = currentRecord(operationId, tempId);
        if (!record) return;
        getApplyRuntime().commit(createCommitEnvelope([{ kind: 'destroy', model: runtime.modelId, ids: [tempId], tombstone: false }], [{ kind: 'remove', operationId }]));
      };
      return { operationId, tempId, execute, cancel };
    };
    const runExecution = async (record: OperationRecord, tempId: string, transportInput: DurableActionTransportInput<TDefinition>): Promise<ActionPayload<TDefinition> | null> => {
      const generationFence = createGenerationFence({ generation: getRuntimeGeneration() });
      const operationId = record.operationId;
      const input = record.input as ActionInput<TDefinition>;
      const context = { operationId, tempId };
      let baseRevision: number | undefined;
      if (record.status === 'failed') {
        const { status, idempotencyKey, ...rest } = record;
        void status;
        const beginOperation = idempotencyKey === undefined ? rest : { ...rest, idempotencyKey };
        getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'begin', operation: beginOperation }]));
      }
      if (!generationFence.isCurrent()) return null;
      try {
        durableDefinition.before?.(input, context);
        if (!generationFence.isCurrent()) return null;
        const variables = durableDefinition.variables(input, transportInput, context);
        if (!generationFence.isCurrent()) return null;
        baseRevision = getApplyRuntime().currentEpoch();
        const data = responseDataOrThrow(await getDbTransport().mutation({ mutation: durableDefinition.document, variables }));
        if (!generationFence.isCurrent()) return null;
        const payload = data[durableDefinition.result];
        if (payload == null) throw new Error(`${durableDefinition.result} returned no data`);
        if (!currentRecord(operationId, tempId)) return null;
        const responseOwner = {
          modelId: runtime.modelId,
          planRows: (rows: readonly unknown[], _options?: { origin?: 'event' }) => {
            if (rows.length !== 1) throw new Error(`${name}: response insert selector must return exactly one row`);
            return getInternalModelHandle(runtime).planReplace(tempId, selectOneRow(rows[0], 'response insert'));
          }
        };
        const responseOps = compileModelRootPlan(responseOwner, durableDefinition.root, { input, data });
        if (responseOps.length === 0) throw new Error(`${name}: response insert selector must return exactly one row`);
        if (!generationFence.isCurrent()) return null;
        const writePlanCollector = createWritePlanCollector({ ownerKey: runtime.modelId });
        durableDefinition.write?.({ input, data }, writePlanCollector.plan);
        const compiledWritePlan = writePlanCollector.compile();
        if (!generationFence.isCurrent()) return null;
        const responseWriteOps = stampCausalRevision([...responseOps, ...compiledWritePlan.writeOps], baseRevision);
        getApplyRuntime().commit(createCommitEnvelope(responseWriteOps, [{ kind: 'close', operationId, status: 'committed' }]));
        if (!generationFence.isCurrent()) return null;
        if (!runWritePlanInvalidations(compiledWritePlan.invalidations, generationFence.isCurrent, error => reportCallbackError(error, 'write.invalidate'))) return null;
        try {
          durableDefinition.track?.({ input, data });
        } catch (callbackError) {
          reportCallbackError(callbackError, 'track');
        }
        if (!generationFence.isCurrent()) return null;
        return payload as ActionPayload<TDefinition>;
      } catch (error) {
        if (!generationFence.isCurrent()) return null;
        const active = currentRecord(operationId, tempId);
        if (active) {
          const status = error instanceof MutationDeliveryUnknownError ? ('delivery_unknown' as const) : ('failed' as const);
          getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'close', operationId, status }]));
          if (generationFence.isCurrent()) {
            try {
              durableDefinition.error?.(error instanceof Error ? error : new Error(String(error)), { ...context, input });
            } catch (callbackError) {
              reportCallbackError(callbackError, 'error');
            }
          }
        }
        throw error;
      }
    };
    return {
      start: (input: ActionInput<TDefinition>) => {
        const serialized = serializeOperationInput(input);
        if (!serialized.serializable) throw new Error(`${name}: action input is not JSON serializable`);
        const operationId = generateTempId('op');
        const tempId = generateTempId('row');
        const optimisticOwner = createOptimisticInsertOwner(tempId);
        const optimisticOps = compileModelRootPlan(optimisticOwner, durableDefinition.optimistic.root, { input, tempId, operationId });
        if (optimisticOps.length === 0) throw new Error(`${name}: optimistic insert selector must return exactly one row`);
        const beginOperation: Omit<OperationRecord, 'status'> = {
          operationId,
          actionKey,
          actionMode: 'durable',
          model: runtime.modelId,
          tempIds: [tempId],
          rowIds: [tempId],
          intent: 'insert',
          input: serialized.value,
          createdAt: Date.now()
        };
        getApplyRuntime().commit(createCommitEnvelope(optimisticOps, [{ kind: 'begin', operation: beginOperation }]));
        return createHandle(operationId, tempId);
      },
      resume: (operationId: string) => {
        const record = getOperationState().get(operationId);
        if (!record || record.tempIds.length !== 1 || record.tempIds[0] === undefined || record.input === undefined || !Object.hasOwn(record, 'input')) return undefined;
        if (record.actionMode !== 'durable' || record.actionKey !== actionKey || record.model !== runtime.modelId || record.intent !== 'insert') return undefined;
        if (record.status !== 'pending' && record.status !== 'failed' && record.status !== 'delivery_unknown') return undefined;
        return createHandle(operationId, record.tempIds[0]);
      },
      open: () =>
        getOperationState()
          .open()
          .filter(
            record =>
              record.actionMode === 'durable' &&
              record.actionKey === actionKey &&
              record.model === runtime.modelId &&
              record.intent === 'insert' &&
              record.tempIds.length === 1 &&
              record.tempIds[0] !== undefined &&
              Object.hasOwn(record, 'input') &&
              record.input !== undefined
          )
          .sort((left, right) => left.createdAt - right.createdAt)
          .map(record => ({
            input: record.input as ActionInput<TDefinition>,
            handle: createHandle(record.operationId, record.tempIds[0]!)
          }))
    } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
  }
  const requestDefinition = definition as ActionRequestDefinition<TDefinition, TStored>;
  const requestPolicy = requestDefinition as typeof requestDefinition & {
    once?: boolean;
    dedupe?: false | { key(input: ActionInput<TDefinition>): string | null };
  };
  if (requestPolicy.once === true && requestPolicy.dedupe === false) {
    throw new Error('once cannot be combined with dedupe: false');
  }
  if (requestPolicy.once === true && requestPolicy.dedupe === undefined) {
    throw new Error('once requires a dedupe key');
  }
  let correlatorRegistered = false;
  const requestIntent = (): OperationRecord['intent'] => modelRootIntentOf(requestDefinition.root);
  const ensureCorrelator = (intent: OperationRecord['intent']): void => {
    if (correlatorRegistered || intent !== 'insert') return;
    const correlate = requestDefinition.optimistic?.correlate;
    if (correlate) registerMutationCorrelator(runtime.modelId, actionKey, correlate);
    correlatorRegistered = true;
  };
  const currentRequestRecord = (operationId: string, tempId: string | null): OperationRecord | undefined => {
    const record = getOperationState().get(operationId);
    if (
      !record ||
      record.actionMode !== 'request' ||
      record.actionKey !== actionKey ||
      record.model !== runtime.modelId ||
      record.status !== 'pending' ||
      !Object.hasOwn(record, 'input')
    ) {
      return undefined;
    }
    if (tempId === null) {
      if (record.tempIds.length !== 0) return undefined;
    } else if (record.tempIds.length !== 1 || record.tempIds[0] !== tempId) {
      return undefined;
    }
    return record;
  };
  const failedRequestRecord = (rowId: string): OperationRecord | undefined => {
    let latest: OperationRecord | undefined;
    for (const record of getOperationState().failedForRow(runtime.modelId, rowId)) {
      if (record.actionMode !== 'request' || record.actionKey !== actionKey) continue;
      if (!latest || record.createdAt >= latest.createdAt) latest = record;
    }
    return latest;
  };
  const deliveryUnknownRequestRecord = (rowId: string): OperationRecord | undefined =>
    getOperationState()
      .deliveryUnknownForRow(runtime.modelId, rowId)
      .find(record => record.actionMode === 'request' && record.actionKey === actionKey);
  const idempotencyKeyFor = (input: ActionInput<TDefinition>, operationId: string): { key: string; deduped: boolean } => {
    if (requestDefinition.dedupe === false) return { key: operationId, deduped: false };
    const key = requestDefinition.dedupe?.key(input);
    if (key == null) return { key: operationId, deduped: false };
    if (typeof key !== 'string' || key.length === 0) throw new Error(`${name}: dedupe key must be a non-empty string`);
    return { key: compositeKey(actionKey, key), deduped: true };
  };
  const buildOptimisticPlan = (input: ActionInput<TDefinition>, tempId: string | null, operationId: string, captureRollback = true): ActionRequestPlan => {
    const optimistic = requestDefinition.optimistic;
    if (!optimistic) {
      return { ops: [], intent: requestIntent(), tempIds: [], rowIds: [] };
    }
    const intent = modelRootIntentOf(optimistic.root);
    if (intent === 'insert') {
      const insertTempId = tempId!;
      const optimisticOwner = createOptimisticInsertOwner(insertTempId);
      const ops = compileModelRootPlan(optimisticOwner, optimistic.root as never, { input, tempId: insertTempId, operationId } as never);
      if (ops.length === 0) throw new Error(`${name}: optimistic insert selector must return exactly one row`);
      return { ops, intent, tempIds: [insertTempId], rowIds: [insertTempId] };
    }
    const ops = compileModelRootPlan(rootOwner, optimistic.root as never, { input, tempId: tempId ?? '', operationId } as never);
    if (intent === 'patch') {
      const operation = ops[0] as Extract<(typeof ops)[number], { kind: 'patch' }>;
      if (!captureRollback) {
        return {
          ops: [{ ...operation, operationId }],
          intent,
          tempIds: [],
          rowIds: [operation.id],
          patchedFields: Object.keys(operation.patch),
          patchedValues: operation.patch
        };
      }
      const previous = getInternalModelHandle(runtime).readRow(operation.id);
      if (!previous) throw new Error(`${name}: optimistic update target is missing`);
      return {
        ops: [{ ...operation, operationId }],
        intent,
        tempIds: [],
        rowIds: [operation.id],
        rollbackRow: previous,
        rollbackMemberships: getInternalModelHandle(runtime).captureMembership(operation.id),
        patchedFields: Object.keys(operation.patch),
        patchedValues: operation.patch
      };
    }
    if (ops.length !== 1 || ops[0]?.kind !== 'destroy' || ops[0].ids.length !== 1) {
      throw new Error(`${name}: optimistic destroy selector must return exactly one destroy`);
    }
    const operation = ops[0];
    const id = operation.ids[0]!;
    if (hasDependentCascade(runtime.modelId)) {
      throw new Error(`${runtime.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
    }
    if (!captureRollback) return { ops, intent, tempIds: [], rowIds: [id] };
    const previous = getInternalModelHandle(runtime).readRow(id);
    if (!previous) throw new Error(`${name}: optimistic destroy target is missing`);
    return {
      ops,
      intent,
      tempIds: [],
      rowIds: [id],
      rollbackRow: previous,
      rollbackMemberships: getInternalModelHandle(runtime).captureMembership(id)
    };
  };
  const runRequestExecution = async (operationId: string, tempId: string | null, input: ActionInput<TDefinition>, tracked: boolean): Promise<ActionPayload<TDefinition> | null> => {
    const generationFence = createGenerationFence({ generation: getRuntimeGeneration() });
    const record = tracked ? currentRequestRecord(operationId, tempId) : undefined;
    if (tracked && !record) return null;
    const context = { tempId, operationId };
    let baseRevision: number | undefined;
    try {
      requestDefinition.before?.(input, context);
      if (!generationFence.isCurrent()) return null;
      const variables = requestDefinition.variables(input, context);
      if (!generationFence.isCurrent()) return null;
      baseRevision = getApplyRuntime().currentEpoch();
      const data = responseDataOrThrow(await getDbTransport().mutation({ mutation: requestDefinition.document, variables }));
      if (!generationFence.isCurrent()) return null;
      const payload = data[requestDefinition.result];
      if (payload == null) throw new Error(`${requestDefinition.result} returned no data`);
      if (tracked && !currentRequestRecord(operationId, tempId)) return null;
      const responseOwner =
        tempId !== null && record?.intent === 'insert'
          ? {
              modelId: runtime.modelId,
              planRows: (rows: readonly unknown[], _options?: { origin?: 'event' }) => {
                if (rows.length !== 1) throw new Error(`${name}: response insert selector must return exactly one row`);
                return getInternalModelHandle(runtime).planReplace(tempId, selectOneRow(rows[0], 'response insert'));
              }
            }
          : rootOwner;
      const responseOps = compileModelRootPlan(responseOwner, requestDefinition.root as never, { input, data } as never).map(operation =>
        operation.kind === 'patch' && record?.intent === 'patch' ? { ...operation, operationId } : operation
      );
      if (tempId !== null && record?.intent === 'insert' && responseOps.length === 0) {
        throw new Error(`${name}: response insert selector must return exactly one row`);
      }
      if (!generationFence.isCurrent()) return null;
      const writePlanCollector = createWritePlanCollector({ ownerKey: runtime.modelId });
      requestDefinition.write?.({ input, data }, writePlanCollector.plan);
      const compiledWritePlan = writePlanCollector.compile();
      if (!generationFence.isCurrent()) return null;
      const responseWriteOps = stampCausalRevision([...responseOps, ...compiledWritePlan.writeOps], baseRevision);
      const responseOperationOps = tracked ? [{ kind: 'close' as const, operationId, status: 'committed' as const }] : [];
      if (responseWriteOps.length > 0 || responseOperationOps.length > 0) {
        getApplyRuntime().commit(createCommitEnvelope(responseWriteOps, responseOperationOps));
      }
      if (!generationFence.isCurrent()) return null;
      if (!runWritePlanInvalidations(compiledWritePlan.invalidations, generationFence.isCurrent, error => reportCallbackError(error, 'write.invalidate'))) return null;
      try {
        requestDefinition.track?.({ input, data });
      } catch (callbackError) {
        reportCallbackError(callbackError, 'track');
      }
      if (!generationFence.isCurrent()) return null;
      return payload as ActionPayload<TDefinition>;
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      const active = tracked ? currentRequestRecord(operationId, tempId) : undefined;
      if (active) {
        if (error instanceof MutationDeliveryUnknownError) {
          getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'close', operationId, status: 'delivery_unknown' }]));
        } else {
          const planned = planRequestFailureRollback(
            active,
            id => getInternalModelHandle(runtime).readRow(id),
            (row, memberships) => getInternalModelHandle(runtime).planRestore(row, memberships)
          );
          getApplyRuntime().commit(createCommitEnvelope(planned.ops, [planned.transition]));
        }
      }
      if (generationFence.isCurrent()) {
        try {
          requestDefinition.error?.(error instanceof Error ? error : new Error(String(error)), { ...context, input });
        } catch (callbackError) {
          reportCallbackError(callbackError, 'error');
        }
      }
      throw error;
    }
  };
  const run = async (input: ActionInput<TDefinition>): Promise<ActionPayload<TDefinition> | null> => {
    const serialized = serializeOperationInput(input);
    if (!serialized.serializable) throw new Error(`${name}: action input is not JSON serializable`);
    const operationId = generateTempId('op');
    const dedupe = idempotencyKeyFor(input, operationId);
    const operations = getOperationState();
    if (dedupe.deduped && requestDefinition.once === true && operations.hasCommitted(dedupe.key)) return null;
    if (dedupe.deduped && operations.hasPending(dedupe.key)) return null;
    const intent = requestIntent();
    ensureCorrelator(intent);
    const optimistic = requestDefinition.optimistic;
    const tempId = optimistic && modelRootIntentOf(optimistic.root) === 'insert' ? generateTempId('row') : null;
    const plan = buildOptimisticPlan(input, tempId, operationId);
    const beginOperation: Omit<OperationRecord, 'status'> = {
      operationId,
      actionKey,
      actionMode: 'request',
      model: runtime.modelId,
      tempIds: plan.tempIds,
      rowIds: plan.rowIds,
      intent: plan.intent,
      idempotencyKey: dedupe.key,
      once: requestDefinition.once === true,
      input: serialized.value,
      ...(plan.rollbackRow !== undefined ? { rollbackRow: plan.rollbackRow } : {}),
      ...(plan.rollbackMemberships !== undefined ? { rollbackMemberships: plan.rollbackMemberships } : {}),
      ...(plan.patchedFields !== undefined ? { patchedFields: plan.patchedFields } : {}),
      ...(plan.patchedValues !== undefined ? { patchedValues: plan.patchedValues } : {}),
      createdAt: Date.now()
    };
    const tracked = optimistic !== undefined || dedupe.deduped;
    if (optimistic) {
      getApplyRuntime().commit(createCommitEnvelope(plan.ops, [{ kind: 'begin', operation: beginOperation }]));
    } else if (tracked) {
      getApplyRuntime().commit(createCommitEnvelope([], [{ kind: 'begin', operation: beginOperation }]));
    }
    return runRequestExecution(operationId, tempId, input, tracked);
  };
  const retry = async (rowId: string): Promise<ActionPayload<TDefinition> | null> => {
    const record = failedRequestRecord(rowId);
    if (!record || record.actionMode !== 'request' || record.actionKey !== actionKey || !Object.hasOwn(record, 'input') || record.input === undefined) return null;
    const input = record.input as ActionInput<TDefinition>;
    const tempId = record.tempIds.length === 1 ? record.tempIds[0]! : null;
    const optimistic = requestDefinition.optimistic;
    if (!optimistic || modelRootIntentOf(optimistic.root) !== record.intent) return null;
    const plan = buildOptimisticPlan(input, tempId, record.operationId, false);
    const idempotency = idempotencyKeyFor(input, record.operationId);
    const { status, ...beginOperation } = {
      ...record,
      actionMode: 'request' as const,
      idempotencyKey: idempotency.key,
      input: record.input
    };
    void status;
    getApplyRuntime().commit(createCommitEnvelope(plan.ops, [{ kind: 'begin', operation: beginOperation }]));
    return runRequestExecution(record.operationId, tempId, input, true);
  };
  const discard = (rowId: string): void => {
    const record = failedRequestRecord(rowId) ?? deliveryUnknownRequestRecord(rowId);
    if (!record || record.actionMode !== 'request' || record.actionKey !== actionKey) return;
    const ops =
      record.intent === 'insert' && record.tempIds.length === 1 ? [{ kind: 'destroy' as const, model: runtime.modelId, ids: [record.tempIds[0]!], tombstone: false }] : [];
    getApplyRuntime().commit(createCommitEnvelope(ops, [{ kind: 'remove', operationId: record.operationId, expectedStatus: record.status }]));
  };
  return {
    run,
    retry,
    discard,
    use: () => {
      return useActionHandle(run);
    }
  } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
};
