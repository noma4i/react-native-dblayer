"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineMutation = void 0;
var _react = require("react");
var _relations = require("../core/relations.js");
var _generateTempId = require("../utils/generateTempId.js");
var _configure = require("./configure.js");
const isMethodOptimistic = value => 'method' in value;

/** Define hook and imperative mutation paths with one lifecycle: optimistic -> transport -> single-transaction commit or rollback. */
const defineMutation = config => {
  const run = async input => {
    const operations = (0, _configure.getOperationState)();
    const dedupeKey = config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (operations.hasCommitted(dedupeKey)) return null;
      if (operations.pending().some(operation => operation.idempotencyKey === dedupeKey)) return null;
    }
    const optimistic = config.optimistic;
    const tracked = optimistic != null || dedupeKey != null;
    const operationId = (0, _generateTempId.generateTempId)('op');
    let tempId = null;
    let previous = null;
    if (optimistic && !isMethodOptimistic(optimistic)) {
      const newTempId = (0, _generateTempId.generateTempId)(optimistic.tempIdPrefix ?? 'row');
      tempId = newTempId;
      const row = optimistic.build(input, {
        tempId: newTempId
      });
      optimistic.model.insertStored({
        ...row,
        id: newTempId
      });
    } else if (optimistic && optimistic.method === 'patch') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.patch(id, optimistic.selectPatch(input));
    } else if (optimistic && optimistic.method === 'destroy') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.destroy(id);
    }
    if (tracked) {
      operations.begin({
        operationId,
        model: optimistic?.model.modelId ?? '',
        tempIds: tempId ? [tempId] : [],
        intent: optimistic ? isMethodOptimistic(optimistic) ? optimistic.method : 'insert' : 'patch',
        idempotencyKey: dedupeKey,
        createdAt: Date.now()
      });
    }
    config.onMutate?.(input, {
      tempId
    });
    try {
      const data = (await (0, _configure.getDbRuntimeConfig)().transport.mutation({
        mutation: config.document,
        variables: {
          input: config.mapInput?.(input) ?? input
        }
      })).data;
      const payload = data?.[config.result];
      if (payload == null) throw new Error(`${config.result} returned no data`);
      const ops = [];
      if (optimistic && !isMethodOptimistic(optimistic) && tempId) {
        const node = optimistic.selectServerNode(data);
        if (node != null) {
          ops.push(...(optimistic.model.__planReplace?.(tempId, node) ?? []));
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
        ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
      }
      if (ops.length > 0) (0, _configure.getApplyRuntime)().apply((0, _relations.expandPlan)(ops));
      if (tracked) operations.close(operationId, 'committed');
      config.onCommit?.(data, {
        tempId,
        input
      });
      config.invalidate?.({
        input,
        data
      });
      config.track?.({
        input,
        data
      });
      return data;
    } catch (error) {
      if (optimistic && !isMethodOptimistic(optimistic) && tempId) optimistic.model.destroy(tempId);
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && previous && typeof previous === 'object') {
        optimistic.model.patch(optimistic.selectId(input), previous);
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && previous && typeof previous === 'object') {
        optimistic.model.insertStored(previous);
      }
      if (tracked) operations.close(operationId, 'rolledback');
      config.onError?.(error, {
        tempId,
        input
      });
      throw error;
    }
  };
  return {
    run,
    use: () => {
      const [isPending, setPending] = (0, _react.useState)(false);
      const [error, setError] = (0, _react.useState)(null);
      const mutateAsync = (0, _react.useCallback)(async input => {
        setPending(true);
        setError(null);
        try {
          return await run(input);
        } catch (nextError) {
          setError(nextError);
          return null;
        } finally {
          setPending(false);
        }
      }, []);
      return {
        mutate: input => {
          void mutateAsync(input);
        },
        mutateAsync,
        isPending,
        error
      };
    }
  };
};
exports.defineMutation = defineMutation;
//# sourceMappingURL=defineMutation.js.map