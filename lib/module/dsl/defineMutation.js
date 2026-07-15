"use strict";

import { useCallback, useState } from 'react';
import { expandPlan, hasDependentCascade } from "../core/relations.js";
import { generateTempId } from "../utils/generateTempId.js";
import { getApplyRuntime, getDbRuntimeConfig, getOperationState, getRuntimeGeneration } from "./configure.js";
const isMethodOptimistic = value => 'method' in value;

/** Define hook and imperative mutation paths with one lifecycle: optimistic -> transport -> single-transaction commit or rollback. */
export const defineMutation = config => {
  const run = async input => {
    const operations = getOperationState();
    const dedupeKey = config.dedupe?.key(input);
    if (dedupeKey != null) {
      if (operations.hasCommitted(dedupeKey)) return null;
      if (operations.hasPending(dedupeKey)) return null;
    }
    const optimistic = config.optimistic;
    const tracked = optimistic != null || dedupeKey != null;
    const operationId = generateTempId('op');
    let tempId = null;
    let insertedTempId = null;
    let previous = null;
    if (optimistic && !isMethodOptimistic(optimistic)) {
      const reuseId = optimistic.existingTempId?.(input) ?? null;
      if (reuseId != null && optimistic.model.get(reuseId) !== undefined) {
        tempId = reuseId;
      } else {
        const newTempId = generateTempId(optimistic.tempIdPrefix ?? 'row');
        tempId = newTempId;
        insertedTempId = newTempId;
        const row = optimistic.build(input, {
          tempId: newTempId
        });
        optimistic.model.insertStored({
          ...row,
          id: newTempId
        });
      }
    } else if (optimistic && optimistic.method === 'patch') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.patch(id, optimistic.selectPatch(input));
    } else if (optimistic && optimistic.method === 'destroy') {
      if (hasDependentCascade(optimistic.model.modelId)) {
        throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
      }
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
        idempotencyKey: dedupeKey ?? undefined,
        createdAt: Date.now()
      });
    }
    config.onMutate?.(input, {
      tempId
    });
    const generation = getRuntimeGeneration();
    try {
      const data = (await getDbRuntimeConfig().transport.mutation({
        mutation: config.document,
        variables: {
          input: config.mapInput?.(input) ?? input
        }
      })).data;
      if (generation !== getRuntimeGeneration()) return null;
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
      if (ops.length > 0) getApplyRuntime().apply(expandPlan(ops));
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
      if (generation !== getRuntimeGeneration()) return null;
      if (optimistic && !isMethodOptimistic(optimistic) && insertedTempId) {
        getApplyRuntime().apply(expandPlan([{
          kind: 'destroy',
          model: optimistic.model.modelId,
          ids: [insertedTempId],
          tombstone: false
        }]));
      }
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && previous && typeof previous === 'object') {
        const previousRecord = previous;
        const restore = {
          ...previousRecord
        };
        for (const key of Object.keys(optimistic.selectPatch(input))) {
          if (!(key in previousRecord)) restore[key] = undefined;
        }
        optimistic.model.patch(optimistic.selectId(input), restore);
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
      const [isPending, setPending] = useState(false);
      const [error, setError] = useState(null);
      /** Rejects on failure (RQ semantics) while still reflecting the error in hook state; resolves null on dedupe skip. */
      const mutateAsync = useCallback(async input => {
        setPending(true);
        setError(null);
        try {
          return await run(input);
        } catch (nextError) {
          setError(nextError);
          throw nextError;
        } finally {
          setPending(false);
        }
      }, []);
      const mutate = useCallback((input, callbacks) => {
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
//# sourceMappingURL=defineMutation.js.map