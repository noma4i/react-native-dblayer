"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createOperation = exports.createAction = void 0;
var _react = require("react");
var _rowOperationState = require("./rowOperationState.js");
var _internalHandles = require("../core/internalHandles.js");
var _relations = require("../core/relations.js");
var _modelRootPlan = require("./modelRootPlan.js");
var _mutationCorrelation = require("./mutationCorrelation.js");
var _commitEnvelope = require("../core/apply/commitEnvelope.js");
var _configure = require("./configure.js");
var _transport = require("../core/transport.js");
var _syncError = require("../core/syncError.js");
var _operationState = require("../core/planes/operationState.js");
var _generateTempId = require("../utils/generateTempId.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _actionHook = require("./actionHook.js");
var _writePlan = require("./writePlan.js");
var _serialize = require("../core/serialize.js");
/**
 * A declared action becomes its runtime handle here. The declared mode decides which action lifecycle
 * carries it - a durable operation, a poller, or a request - and the caller sees one handle either
 * way, so a consumer never reproduces the lifecycle of the mode it happened to get.
 */
const createOperation = (runtime, id) => ({
  read: () => (0, _rowOperationState.readRowOperationState)(runtime.modelId, id),
  use: () => (0, _rowOperationState.useRowOperationState)(runtime.modelId, id)
});
exports.createOperation = createOperation;
const createAction = (runtime, name, definition) => {
  const rootOwner = {
    modelId: runtime.modelId,
    planRows: (rows, options) => (0, _internalHandles.getInternalModelHandle)(runtime).planRows([...rows], options ?? {
      origin: 'event'
    })
  };
  const selectOneRow = (value, selector) => {
    if (!(0, _normalizeHelpers.isNonArrayRecord)(value)) throw new Error(`${name}: ${selector} selector must return exactly one row`);
    return value;
  };
  const actionKey = name;
  const reportCallbackError = (error, callback) => {
    (0, _syncError.reportSyncError)(error, {
      source: 'action',
      model: runtime.modelId,
      key: callback
    }, 'modelAction');
  };
  if (definition.mode === 'durable') {
    const durableDefinition = definition;
    const executions = new Map();
    const currentRecord = (operationId, tempId) => {
      const record = (0, _configure.getOperationState)().get(operationId);
      if (!record || record.actionMode !== 'durable' || record.actionKey !== actionKey || record.model !== runtime.modelId || record.intent !== 'insert' || record.status !== 'pending' && record.status !== 'failed' || record.tempIds.length !== 1 || record.tempIds[0] !== tempId || !Object.hasOwn(record, 'input') || record.input === undefined) {
        return undefined;
      }
      return record;
    };
    const createHandle = (operationId, tempId) => {
      const execute = transportInput => {
        const record = currentRecord(operationId, tempId);
        if (!record) return Promise.resolve(null);
        const existing = executions.get(operationId);
        if (existing) return existing;
        const promise = runExecution(record, tempId, transportInput);
        executions.set(operationId, promise);
        void promise.then(() => {
          if (executions.get(operationId) === promise) executions.delete(operationId);
        }, () => {
          if (executions.get(operationId) === promise) executions.delete(operationId);
        });
        return promise;
      };
      const cancel = () => {
        const record = currentRecord(operationId, tempId);
        if (!record) return;
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
          kind: 'destroy',
          model: runtime.modelId,
          ids: [tempId],
          tombstone: false
        }], [{
          kind: 'remove',
          operationId
        }]));
      };
      return {
        operationId,
        tempId,
        execute,
        cancel
      };
    };
    const runExecution = async (record, tempId, transportInput) => {
      const generationFence = (0, _runtimeGeneration.createGenerationFence)({
        generation: (0, _configure.getRuntimeGeneration)()
      });
      const operationId = record.operationId;
      const input = record.input;
      const context = {
        operationId,
        tempId
      };
      let baseRevision;
      if (record.status === 'failed') {
        const {
          status,
          ...beginOperation
        } = record;
        void status;
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([], [{
          kind: 'begin',
          operation: beginOperation
        }]));
      }
      if (!generationFence.isCurrent()) return null;
      try {
        durableDefinition.before?.(input, context);
        if (!generationFence.isCurrent()) return null;
        const variables = durableDefinition.variables(input, transportInput, context);
        if (!generationFence.isCurrent()) return null;
        baseRevision = (0, _configure.getApplyRuntime)().currentEpoch();
        const data = (0, _transport.responseDataOrThrow)(await (0, _transport.getDbTransport)().mutation({
          mutation: durableDefinition.document,
          variables
        }));
        if (!generationFence.isCurrent()) return null;
        const payload = data[durableDefinition.result];
        if (payload == null) throw new Error(`${durableDefinition.result} returned no data`);
        if (!currentRecord(operationId, tempId)) return null;
        const responseOwner = {
          modelId: runtime.modelId,
          planRows: (rows, _options) => {
            if (rows.length !== 1) throw new Error(`${name}: response insert selector must return exactly one row`);
            return (0, _internalHandles.getInternalModelHandle)(runtime).planReplace(tempId, selectOneRow(rows[0], 'response insert'));
          }
        };
        const responseOps = (0, _modelRootPlan.compileModelRootPlan)(responseOwner, durableDefinition.root, {
          input,
          data
        });
        if (responseOps.length === 0) throw new Error(`${name}: response insert selector must return exactly one row`);
        if (!generationFence.isCurrent()) return null;
        const writePlanCollector = (0, _writePlan.createWritePlanCollector)({
          ownerKey: runtime.modelId
        });
        durableDefinition.write?.({
          input,
          data
        }, writePlanCollector.plan);
        const compiledWritePlan = writePlanCollector.compile();
        if (!generationFence.isCurrent()) return null;
        const responseWriteOps = (0, _writePlan.stampCausalRevision)([...responseOps, ...compiledWritePlan.writeOps], baseRevision);
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(responseWriteOps, [{
          kind: 'close',
          operationId,
          status: 'committed'
        }]));
        if (!generationFence.isCurrent()) return null;
        if (!(0, _writePlan.runWritePlanInvalidations)(compiledWritePlan.invalidations, generationFence.isCurrent, error => reportCallbackError(error, 'write.invalidate'))) return null;
        try {
          durableDefinition.track?.({
            input,
            data
          });
        } catch (callbackError) {
          reportCallbackError(callbackError, 'track');
        }
        if (!generationFence.isCurrent()) return null;
        return payload;
      } catch (error) {
        if (!generationFence.isCurrent()) return null;
        const active = currentRecord(operationId, tempId);
        if (active) {
          (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([], [{
            kind: 'close',
            operationId,
            status: 'failed'
          }]));
          if (generationFence.isCurrent()) {
            try {
              durableDefinition.error?.(error instanceof Error ? error : new Error(String(error)), {
                ...context,
                input
              });
            } catch (callbackError) {
              reportCallbackError(callbackError, 'error');
            }
          }
        }
        throw error;
      }
    };
    return {
      start: input => {
        const serialized = (0, _operationState.serializeOperationInput)(input);
        if (!serialized.serializable) throw new Error(`${name}: action input is not JSON serializable`);
        const operationId = (0, _generateTempId.generateTempId)('op');
        const tempId = (0, _generateTempId.generateTempId)('row');
        const optimisticOwner = {
          modelId: runtime.modelId,
          planRows: rows => {
            if (rows.length !== 1) throw new Error(`${name}: optimistic insert selector must return exactly one row`);
            const row = selectOneRow(rows[0], 'optimistic insert');
            return rootOwner.planRows([{
              ...row,
              id: tempId
            }]);
          }
        };
        const optimisticOps = (0, _modelRootPlan.compileModelRootPlan)(optimisticOwner, durableDefinition.optimistic.root, {
          input,
          tempId,
          operationId
        });
        if (optimisticOps.length === 0) throw new Error(`${name}: optimistic insert selector must return exactly one row`);
        const beginOperation = {
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
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(optimisticOps, [{
          kind: 'begin',
          operation: beginOperation
        }]));
        return createHandle(operationId, tempId);
      },
      resume: operationId => {
        const record = (0, _configure.getOperationState)().get(operationId);
        if (!record || record.tempIds.length !== 1 || record.tempIds[0] === undefined || record.input === undefined || !Object.hasOwn(record, 'input')) return undefined;
        if (record.actionMode !== 'durable' || record.actionKey !== actionKey || record.model !== runtime.modelId || record.intent !== 'insert') return undefined;
        if (record.status !== 'pending' && record.status !== 'failed') return undefined;
        return createHandle(operationId, record.tempIds[0]);
      },
      open: () => (0, _configure.getOperationState)().open().filter(record => record.actionMode === 'durable' && record.actionKey === actionKey && record.model === runtime.modelId && record.intent === 'insert' && record.tempIds.length === 1 && record.tempIds[0] !== undefined && Object.hasOwn(record, 'input') && record.input !== undefined).sort((left, right) => left.createdAt - right.createdAt).map(record => ({
        input: record.input,
        handle: createHandle(record.operationId, record.tempIds[0])
      }))
    };
  }
  if (definition.mode === 'poll') {
    const inputs = new Map();
    const refs = new Map();
    const baseRevisions = new Map();
    const poller = runtime.poller(name, {
      document: definition.document,
      vars: id => {
        baseRevisions.set(id, (0, _configure.getApplyRuntime)().currentEpoch());
        return definition.variables(inputs.get(id), {
          sessionKey: id
        });
      },
      apply: (id, data) => {
        const baseRevision = baseRevisions.get(id);
        const ops = (0, _writePlan.stampCausalRevision)((0, _modelRootPlan.compileModelRootPlan)(rootOwner, definition.root, data), baseRevision);
        if (ops.length > 0) (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(ops));
      },
      classify: definition.poll.classify,
      intervalMs: definition.poll.intervalMs,
      maxAttempts: definition.poll.maxAttempts
    });
    const idFor = input => {
      const id = definition.poll.key(input);
      if (id.length === 0) throw new Error('Poll action key must be a non-empty string');
      return id;
    };
    const retain = id => {
      refs.set(id, (refs.get(id) ?? 0) + 1);
    };
    const release = id => {
      const next = refs.get(id) - 1;
      if (next > 0) {
        refs.set(id, next);
        return;
      }
      refs.delete(id);
      inputs.delete(id);
      baseRevisions.delete(id);
    };
    return {
      run: async input => {
        const id = idFor(input);
        inputs.set(id, input);
        try {
          await poller.refresh(id);
        } finally {
          if (!refs.has(id)) inputs.delete(id);
        }
      },
      use: input => {
        const id = input == null ? null : idFor(input);
        if (id) inputs.set(id, input);
        const phase = poller.usePhase(id ?? `${name}:inactive`);
        (0, _react.useEffect)(() => {
          if (!id) return;
          retain(id);
          const detach = poller.attach(id);
          return () => {
            detach();
            release(id);
          };
        }, [id]);
        return {
          ...(id ? phase : {
            phase: 'idle',
            attempts: 0
          }),
          refresh: async () => {
            if (!id || input == null) return;
            inputs.set(id, input);
            const currentPhase = poller.getPhase(id).phase;
            if (currentPhase === 'ready' || currentPhase === 'failed' || currentPhase === 'stalled') {
              await poller.refresh(id, {
                resetBudget: true
              });
              return;
            }
            await poller.refresh(id);
          }
        };
      }
    };
  }
  const requestDefinition = definition;
  if (requestDefinition.once === true && requestDefinition.dedupe === false) {
    throw new Error('once cannot be combined with dedupe: false');
  }
  let correlatorRegistered = false;
  const requestIntent = () => (0, _modelRootPlan.modelRootIntentOf)(requestDefinition.root);
  const ensureCorrelator = intent => {
    if (correlatorRegistered || intent !== 'insert') return;
    const correlate = requestDefinition.optimistic?.correlate;
    if (correlate) (0, _mutationCorrelation.registerMutationCorrelator)(runtime.modelId, actionKey, correlate);
    correlatorRegistered = true;
  };
  const currentRequestRecord = (operationId, tempId) => {
    const record = (0, _configure.getOperationState)().get(operationId);
    if (!record || record.actionMode !== 'request' || record.actionKey !== actionKey || record.model !== runtime.modelId || record.status !== 'pending' || !Object.hasOwn(record, 'input')) {
      return undefined;
    }
    if (tempId === null) {
      if (record.tempIds.length !== 0) return undefined;
    } else if (record.tempIds.length !== 1 || record.tempIds[0] !== tempId) {
      return undefined;
    }
    return record;
  };
  const failedRequestRecord = rowId => {
    let latest;
    for (const record of (0, _configure.getOperationState)().failedForRow(runtime.modelId, rowId)) {
      if (record.actionMode !== 'request' || record.actionKey !== actionKey) continue;
      if (!latest || record.createdAt >= latest.createdAt) latest = record;
    }
    return latest;
  };
  const idempotencyKeyFor = (input, operationId) => {
    if (requestDefinition.dedupe === false) return {
      key: operationId,
      deduped: false
    };
    const key = requestDefinition.dedupe?.key(input);
    if (key == null) return {
      key: operationId,
      deduped: false
    };
    if (typeof key !== 'string' || key.length === 0) throw new Error(`${name}: dedupe key must be a non-empty string`);
    return {
      key,
      deduped: true
    };
  };
  const buildOptimisticPlan = (input, tempId, operationId, captureRollback = true) => {
    const optimistic = requestDefinition.optimistic;
    if (!optimistic) {
      return {
        ops: [],
        intent: requestIntent(),
        tempIds: [],
        rowIds: []
      };
    }
    const intent = (0, _modelRootPlan.modelRootIntentOf)(optimistic.root);
    if (intent === 'insert') {
      const insertTempId = tempId;
      const optimisticOwner = {
        modelId: runtime.modelId,
        planRows: (rows, _options) => {
          if (rows.length !== 1) throw new Error(`${name}: optimistic insert selector must return exactly one row`);
          const row = selectOneRow(rows[0], 'optimistic insert');
          return rootOwner.planRows([{
            ...row,
            id: insertTempId
          }]);
        }
      };
      const ops = (0, _modelRootPlan.compileModelRootPlan)(optimisticOwner, optimistic.root, {
        input,
        tempId: insertTempId,
        operationId
      });
      if (ops.length === 0) throw new Error(`${name}: optimistic insert selector must return exactly one row`);
      return {
        ops,
        intent,
        tempIds: [insertTempId],
        rowIds: [insertTempId]
      };
    }
    const ops = (0, _modelRootPlan.compileModelRootPlan)(rootOwner, optimistic.root, {
      input,
      tempId: tempId ?? '',
      operationId
    });
    if (intent === 'patch') {
      const operation = ops[0];
      if (!captureRollback) {
        return {
          ops: [{
            ...operation,
            operationId
          }],
          intent,
          tempIds: [],
          rowIds: [operation.id],
          patchedFields: Object.keys(operation.patch),
          patchedValues: operation.patch
        };
      }
      const previous = (0, _internalHandles.getInternalModelHandle)(runtime).readRow(operation.id);
      if (!previous) throw new Error(`${name}: optimistic update target is missing`);
      return {
        ops: [{
          ...operation,
          operationId
        }],
        intent,
        tempIds: [],
        rowIds: [operation.id],
        rollbackRow: previous,
        rollbackMemberships: (0, _internalHandles.getInternalModelHandle)(runtime).captureMembership(operation.id),
        patchedFields: Object.keys(operation.patch),
        patchedValues: operation.patch
      };
    }
    if (ops.length !== 1 || ops[0]?.kind !== 'destroy' || ops[0].ids.length !== 1) {
      throw new Error(`${name}: optimistic destroy selector must return exactly one destroy`);
    }
    const operation = ops[0];
    const id = operation.ids[0];
    if ((0, _relations.hasDependentCascade)(runtime.modelId)) {
      throw new Error(`${runtime.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
    }
    if (!captureRollback) return {
      ops,
      intent,
      tempIds: [],
      rowIds: [id]
    };
    const previous = (0, _internalHandles.getInternalModelHandle)(runtime).readRow(id);
    if (!previous) throw new Error(`${name}: optimistic destroy target is missing`);
    return {
      ops,
      intent,
      tempIds: [],
      rowIds: [id],
      rollbackRow: previous,
      rollbackMemberships: (0, _internalHandles.getInternalModelHandle)(runtime).captureMembership(id)
    };
  };
  const runRequestExecution = async (operationId, tempId, input, tracked) => {
    const generationFence = (0, _runtimeGeneration.createGenerationFence)({
      generation: (0, _configure.getRuntimeGeneration)()
    });
    const record = tracked ? currentRequestRecord(operationId, tempId) : undefined;
    if (tracked && !record) return null;
    const context = {
      tempId,
      operationId
    };
    let baseRevision;
    try {
      requestDefinition.before?.(input, context);
      if (!generationFence.isCurrent()) return null;
      const variables = requestDefinition.variables(input, context);
      if (!generationFence.isCurrent()) return null;
      baseRevision = (0, _configure.getApplyRuntime)().currentEpoch();
      const data = (0, _transport.responseDataOrThrow)(await (0, _transport.getDbTransport)().mutation({
        mutation: requestDefinition.document,
        variables
      }));
      if (!generationFence.isCurrent()) return null;
      const payload = data[requestDefinition.result];
      if (payload == null) throw new Error(`${requestDefinition.result} returned no data`);
      if (tracked && !currentRequestRecord(operationId, tempId)) return null;
      const responseOwner = tempId !== null && record?.intent === 'insert' ? {
        modelId: runtime.modelId,
        planRows: (rows, _options) => {
          if (rows.length !== 1) throw new Error(`${name}: response insert selector must return exactly one row`);
          return (0, _internalHandles.getInternalModelHandle)(runtime).planReplace(tempId, selectOneRow(rows[0], 'response insert'));
        }
      } : rootOwner;
      const responseOps = (0, _modelRootPlan.compileModelRootPlan)(responseOwner, requestDefinition.root, {
        input,
        data
      }).map(operation => operation.kind === 'patch' && record?.intent === 'patch' ? {
        ...operation,
        operationId
      } : operation);
      if (tempId !== null && record?.intent === 'insert' && responseOps.length === 0) {
        throw new Error(`${name}: response insert selector must return exactly one row`);
      }
      if (!generationFence.isCurrent()) return null;
      const writePlanCollector = (0, _writePlan.createWritePlanCollector)({
        ownerKey: runtime.modelId
      });
      requestDefinition.write?.({
        input,
        data
      }, writePlanCollector.plan);
      const compiledWritePlan = writePlanCollector.compile();
      if (!generationFence.isCurrent()) return null;
      const responseWriteOps = (0, _writePlan.stampCausalRevision)([...responseOps, ...compiledWritePlan.writeOps], baseRevision);
      const responseOperationOps = tracked ? [{
        kind: 'close',
        operationId,
        status: 'committed'
      }] : [];
      if (responseWriteOps.length > 0 || responseOperationOps.length > 0) {
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(responseWriteOps, responseOperationOps));
      }
      if (!generationFence.isCurrent()) return null;
      if (!(0, _writePlan.runWritePlanInvalidations)(compiledWritePlan.invalidations, generationFence.isCurrent, error => reportCallbackError(error, 'write.invalidate'))) return null;
      try {
        requestDefinition.track?.({
          input,
          data
        });
      } catch (callbackError) {
        reportCallbackError(callbackError, 'track');
      }
      if (!generationFence.isCurrent()) return null;
      return payload;
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      const active = tracked ? currentRequestRecord(operationId, tempId) : undefined;
      if (active) {
        const rollbackOps = active.intent === 'patch' && active.rollbackRow !== undefined ? (() => {
          const rowId = active.rowIds[0];
          const current = (0, _internalHandles.getInternalModelHandle)(runtime).readRow(rowId);
          if (!current) return [];
          const patch = {};
          const remove = [];
          for (const field of active.patchedFields) {
            const latest = (0, _configure.getOperationState)().latestPendingValue(runtime.modelId, rowId, field, operationId);
            if (latest.found) {
              patch[field] = latest.value;
              continue;
            }
            if (!active.patchedValues || (0, _serialize.stableSerialize)(current[field]) !== (0, _serialize.stableSerialize)(active.patchedValues[field])) continue;
            if (Object.hasOwn(active.rollbackRow, field)) {
              patch[field] = active.rollbackRow[field];
              continue;
            }
            remove.push(field);
          }
          return [{
            kind: 'patch',
            model: runtime.modelId,
            id: rowId,
            patch,
            remove,
            operationId
          }];
        })() : active.intent === 'destroy' && active.rollbackRow !== undefined && active.rollbackMemberships !== undefined ? (0, _internalHandles.getInternalModelHandle)(runtime).planRestore(active.rollbackRow, active.rollbackMemberships) : [];
        const status = active.tempIds.length > 0 || active.rollbackRow !== undefined ? 'failed' : 'rolledback';
        (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(rollbackOps, [{
          kind: 'close',
          operationId,
          status
        }]));
      }
      if (generationFence.isCurrent()) {
        try {
          requestDefinition.error?.(error instanceof Error ? error : new Error(String(error)), {
            ...context,
            input
          });
        } catch (callbackError) {
          reportCallbackError(callbackError, 'error');
        }
      }
      throw error;
    }
  };
  const run = async input => {
    const serialized = (0, _operationState.serializeOperationInput)(input);
    if (!serialized.serializable) throw new Error(`${name}: action input is not JSON serializable`);
    const operationId = (0, _generateTempId.generateTempId)('op');
    const dedupe = idempotencyKeyFor(input, operationId);
    const operations = (0, _configure.getOperationState)();
    if (dedupe.deduped && requestDefinition.once === true && operations.hasCommitted(dedupe.key)) return null;
    if (dedupe.deduped && operations.hasPending(dedupe.key)) return null;
    const intent = requestIntent();
    ensureCorrelator(intent);
    const optimistic = requestDefinition.optimistic;
    const tempId = optimistic && (0, _modelRootPlan.modelRootIntentOf)(optimistic.root) === 'insert' ? (0, _generateTempId.generateTempId)('row') : null;
    const plan = buildOptimisticPlan(input, tempId, operationId);
    const beginOperation = {
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
      ...(plan.rollbackRow !== undefined ? {
        rollbackRow: plan.rollbackRow
      } : {}),
      ...(plan.rollbackMemberships !== undefined ? {
        rollbackMemberships: plan.rollbackMemberships
      } : {}),
      ...(plan.patchedFields !== undefined ? {
        patchedFields: plan.patchedFields
      } : {}),
      ...(plan.patchedValues !== undefined ? {
        patchedValues: plan.patchedValues
      } : {}),
      createdAt: Date.now()
    };
    const tracked = optimistic !== undefined || dedupe.deduped;
    if (optimistic) {
      (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(plan.ops, [{
        kind: 'begin',
        operation: beginOperation
      }]));
    } else if (tracked) {
      (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([], [{
        kind: 'begin',
        operation: beginOperation
      }]));
    }
    return runRequestExecution(operationId, tempId, input, tracked);
  };
  const retry = async rowId => {
    const record = failedRequestRecord(rowId);
    if (!record || record.actionMode !== 'request' || record.actionKey !== actionKey || !Object.hasOwn(record, 'input') || record.input === undefined) return null;
    const input = record.input;
    const tempId = record.tempIds.length === 1 ? record.tempIds[0] : null;
    const optimistic = requestDefinition.optimistic;
    if (!optimistic || (0, _modelRootPlan.modelRootIntentOf)(optimistic.root) !== record.intent) return null;
    const plan = buildOptimisticPlan(input, tempId, record.operationId, false);
    const idempotency = idempotencyKeyFor(input, record.operationId);
    const {
      status,
      ...beginOperation
    } = {
      ...record,
      actionMode: 'request',
      idempotencyKey: idempotency.key,
      input: record.input
    };
    void status;
    (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(plan.ops, [{
      kind: 'begin',
      operation: beginOperation
    }]));
    return runRequestExecution(record.operationId, tempId, input, true);
  };
  const discard = rowId => {
    const record = failedRequestRecord(rowId);
    if (!record || record.actionMode !== 'request' || record.actionKey !== actionKey) return;
    const ops = record.intent === 'insert' && record.tempIds.length === 1 ? [{
      kind: 'destroy',
      model: runtime.modelId,
      ids: [record.tempIds[0]],
      tombstone: false
    }] : [];
    (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(ops, [{
      kind: 'remove',
      operationId: record.operationId,
      expectedStatus: 'failed'
    }]));
  };
  return {
    run,
    retry,
    discard,
    use: () => {
      return (0, _actionHook.useActionHandle)(run);
    }
  };
};
exports.createAction = createAction;
//# sourceMappingURL=facadeActions.js.map