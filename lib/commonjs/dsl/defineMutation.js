"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineMutation = void 0;
var _react = require("react");
var _relations = require("../core/relations.js");
var _logger = require("../core/logger.js");
var _generateTempId = require("../utils/generateTempId.js");
var _runtimePrimitives = require("../utils/runtimePrimitives.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _bootValidations = require("./bootValidations.js");
var _configure = require("./configure.js");
var _internalHandles = require("../core/internalHandles.js");
/** A server-order scope plus the mutation-input mapping that selects its concrete scope value. */

/**
 * Context shared by optimistic and transport-variable builders for one mutation run.
 * Send `operationId` to the server, echo it on subscription events, and pass it as
 * `operationId` in the declaration returned by `defineIngest` to skip committed echoes.
 */

/**
 * Optimistic insert: writes a temp row immediately, then replaces it with the server node on commit
 * (or removes it on error/rollback).
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
 * @param config Document, result field, optional optimistic write, dedupe key, extract sinks, and lifecycle callbacks.
 * @returns `{ run, use }`. `run(input)` executes one mutation outside React, resolving to the response data,
 * or `null` when dedupe skipped it. `use()` is a hook returning `{ mutate, mutateAsync, isPending, error }`,
 * where `mutate` fires-and-forgets with optional `MutateCallbacks` and `mutateAsync` awaits/rejects like `run`.
 */
const defineMutation = config => {
  const optimisticConfig = config.optimistic;
  if (optimisticConfig && isRespondOptimistic(optimisticConfig) && (`build` in optimisticConfig || `method` in optimisticConfig)) {
    throw new Error(`optimistic respond cannot be combined with build or method`);
  }
  if (optimisticConfig && isMethodOptimistic(optimisticConfig) && (`prependTo` in optimisticConfig || `appendTo` in optimisticConfig)) {
    throw new Error(`optimistic prependTo/appendTo requires an insert optimistic config`);
  }
  if (optimisticConfig && isMethodOptimistic(optimisticConfig) && optimisticConfig.method === 'destroy') {
    (0, _bootValidations.registerBootValidation)(() => {
      if ((0, _relations.hasDependentCascade)(optimisticConfig.model.modelId)) {
        throw new Error(`${optimisticConfig.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
      }
    });
  }
  if (optimisticConfig && !isMethodOptimistic(optimisticConfig)) {
    if (optimisticConfig.prependTo && optimisticConfig.appendTo) throw new Error(`optimistic prependTo and appendTo are mutually exclusive`);
    const placement = optimisticConfig.prependTo ?? optimisticConfig.appendTo;
    if (placement && !(0, _internalHandles.getInternalScopeHandle)(placement.scope).isServerOrder()) throw new Error(`optimistic prependTo/appendTo requires a server-order scope`);
    if (placement && placement.scope.modelId !== optimisticConfig.model.modelId) throw new Error(`optimistic prependTo/appendTo scope must belong to the optimistic model`);
  }

  /** Ensures auto membership deltas yield to explicit placement orders. */
  const dedupePlacementAppends = (plan, placementOps) => {
    const placementIds = new Map();
    for (const op of placementOps) {
      if (op.kind !== 'scope-delta') continue;
      const key = `${op.model}\0${op.scopeKey}`;
      const ids = placementIds.get(key) ?? new Set();
      for (const row of op.append) ids.add(row.id);
      placementIds.set(key, ids);
    }
    return plan.flatMap(op => {
      if (op.kind !== 'scope-delta') return [op];
      const ids = placementIds.get(`${op.model}\0${op.scopeKey}`);
      if (!ids) return [op];
      const append = op.append.filter(row => row.order !== undefined || !ids.has(row.id));
      return append.length > 0 || op.detach.length > 0 ? [{
        ...op,
        append
      }] : [];
    });
  };
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
      if (context.tempId && id !== context.tempId && optimistic.model.get(context.tempId) !== undefined) ops.push(...(0, _internalHandles.getInternalModelHandle)(optimistic.model).planReplace(context.tempId, row));else ops.push(...(0, _internalHandles.getInternalModelHandle)(optimistic.model).planRows([row]));
      const placement = optimistic.prependTo ?? optimistic.appendTo;
      if (placement && context.tempId && id === context.tempId) ops.push(...(0, _internalHandles.getInternalScopeHandle)(placement.scope).planPlacement(placement.value(input), id, optimistic.prependTo ? 'prepend' : 'append'));
    }
    for (const sink of config.extract?.({
      data
    }) ?? []) ops.push(...(0, _internalHandles.getInternalModelHandle)(sink.into).planRows(sink.rows));
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
      for (const row of sink.rows) if ((0, _normalizeHelpers.isRecord)(row) && typeof row.id === 'string') targets.push({
        model,
        id: row.id
      });
    }
    return targets.flatMap(({
      model,
      id
    }) => {
      const previous = model.get?.(id);
      if (previous === undefined) return [{
        kind: 'destroy',
        model: model.modelId,
        ids: [id],
        tombstone: false
      }];
      const internal = (0, _internalHandles.getInternalModelHandle)(model);
      const memberships = internal.captureMembership(id);
      return internal.planRestore(previous, memberships);
    });
  };
  const run = async input => {
    const operations = (0, _configure.getOperationState)();
    const dedupeKey = config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (operations.hasCommitted(dedupeKey)) return null;
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
    if (optimistic && isRespondOptimistic(optimistic)) {
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
      const placementOps = optimisticOps.filter(op => op.kind === 'scope-delta' && op.append.some(row => row.order !== undefined));
      if (optimisticOps.length > 0) (0, _configure.getApplyRuntime)().apply(dedupePlacementAppends((0, _relations.expandPlan)(optimisticOps), placementOps));
    } else if (optimistic && !isMethodOptimistic(optimistic)) {
      const reuseId = optimistic.existingTempId?.(input) ?? null;
      if (reuseId != null && optimistic.model.get(reuseId) !== undefined) {
        tempId = reuseId;
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
        let placementOps = [];
        if (placement) {
          placementOps = (0, _internalHandles.getInternalScopeHandle)(placement.scope).planPlacement(placement.value(input), newTempId, position);
          ops.push(...placementOps);
        }
        (0, _configure.getApplyRuntime)().apply(dedupePlacementAppends((0, _relations.expandPlan)(ops), placementOps));
      }
    } else if (optimistic && optimistic.method === 'patch') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.patch(id, optimistic.selectPatch(input));
    } else if (optimistic && optimistic.method === 'destroy') {
      if ((0, _relations.hasDependentCascade)(optimistic.model.modelId)) {
        throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
      }
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      previousMemberships = (0, _internalHandles.getInternalModelHandle)(optimistic.model).captureMembership(id);
      optimistic.model.destroy(id);
    }
    if (tracked) {
      const operationIds = tempId ? [tempId] : optimistic && isMethodOptimistic(optimistic) ? [optimistic.selectId(input)] : [];
      operations.begin({
        operationId,
        model: optimistic?.model.modelId ?? '',
        tempIds: tempId ? [tempId] : [],
        rowIds: operationIds,
        intent: optimistic ? isMethodOptimistic(optimistic) ? optimistic.method : 'insert' : 'patch',
        idempotencyKey: dedupeKey ?? operationId,
        createdAt: Date.now()
      });
    }
    const context = {
      tempId,
      operationId
    };
    config.onMutate?.(input, context);
    const generationFence = (0, _runtimePrimitives.createGenerationFence)();
    let data;
    try {
      data = (await (0, _configure.getDbRuntimeConfig)().transport.mutation({
        mutation: config.document,
        variables: {
          input: config.mapInput?.(input, context) ?? input
        }
      })).data;
      if (!generationFence.isCurrent()) return null;
      const payload = data?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);
      const ops = [];
      let placementOps = [];
      if (optimistic && isRespondOptimistic(optimistic)) {
        const respondOps = planFromRespond(data, context, optimistic, input);
        ops.push(...respondOps);
        placementOps = respondOps.filter(op => op.kind === 'scope-delta' && op.append.some(row => row.order !== undefined));
      } else if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) {
          ops.push(...(0, _internalHandles.getInternalModelHandle)(optimistic.model).planReplace(tempId, node));
          if (optimistic.preserveOnCommit?.length) {
            const current = optimistic.model.get(tempId);
            if (current) {
              const preserved = {};
              for (const field of optimistic.preserveOnCommit) {
                if (current[field] !== undefined) preserved[field] = current[field];
              }
              if (Object.keys(preserved).length > 0) {
                ops.push({
                  kind: 'patch',
                  model: optimistic.model.modelId,
                  id: optimistic.model.normalize(node).id,
                  patch: preserved
                });
              }
            }
          }
        }
      }
      for (const sink of config.extract?.({
        data
      }) ?? []) {
        ops.push(...(0, _internalHandles.getInternalModelHandle)(sink.into).planRows(sink.rows));
      }
      if (ops.length > 0) (0, _configure.getApplyRuntime)().apply(dedupePlacementAppends((0, _relations.expandPlan)(ops), placementOps));
      if (tracked) operations.close(operationId, 'committed');
    } catch (error) {
      if (!generationFence.isCurrent()) return null;
      if (optimistic && isRespondOptimistic(optimistic) && insertedTempId) {
        if (respondInverse.length > 0) (0, _configure.getApplyRuntime)().apply((0, _relations.expandPlan)(respondInverse));
      } else if (optimistic && !isMethodOptimistic(optimistic) && insertedTempId) {
        (0, _configure.getApplyRuntime)().apply((0, _relations.expandPlan)([{
          kind: 'destroy',
          model: optimistic.model.modelId,
          ids: [insertedTempId],
          tombstone: false
        }]));
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && (0, _normalizeHelpers.isRecord)(previous)) {
        const previousRecord = previous;
        const restore = {
          ...previousRecord
        };
        for (const key of Object.keys(optimistic.selectPatch(input))) {
          if (!(key in previousRecord)) restore[key] = undefined;
        }
        optimistic.model.patch(optimistic.selectId(input), restore);
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && (0, _normalizeHelpers.isRecord)(previous)) {
        (0, _configure.getApplyRuntime)().apply((0, _relations.expandPlan)((0, _internalHandles.getInternalModelHandle)(optimistic.model).planRestore(previous, previousMemberships)));
      }
      if (tracked) operations.close(operationId, 'rolledback');
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        (0, _configure.getDbRuntimeConfig)().defaults?.onSyncError?.(reported, {
          source: 'mutation',
          model: optimistic?.model.modelId
        });
      } catch (observerError) {
        (0, _logger.getDbLogger)().error('defineMutation onSyncError failed', {
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
        (0, _logger.getDbLogger)().error('defineMutation post-commit callback failed', {
          callback,
          error: reported
        });
      } catch {}
      try {
        (0, _configure.getDbRuntimeConfig)().defaults?.onSyncError?.(reported, {
          source: 'mutation',
          model: optimistic?.model.modelId
        });
      } catch {}
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
  return {
    run,
    use: () => {
      const runRef = (0, _react.useRef)(run);
      runRef.current = run;
      const [isPending, setPending] = (0, _react.useState)(false);
      const [error, setError] = (0, _react.useState)(null);
      /** Rejects on failure (RQ semantics) while still reflecting the error in hook state; resolves null on dedupe skip. */
      const mutateAsync = (0, _react.useCallback)(async input => {
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
      const mutate = (0, _react.useCallback)((input, callbacks) => {
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
exports.defineMutation = defineMutation;
//# sourceMappingURL=defineMutation.js.map