"use strict";

import { useCallback, useState } from 'react';
import { getDbRuntimeConfig } from "./configure.js";
let nextTempSequence = 0;
const tempId = prefix => `${prefix}:${++nextTempSequence}`;
const isMethodOptimistic = value => typeof value === 'object' && value !== null && 'method' in value;

/** Define hook and imperative mutation paths with identical transport execution. */
export const defineMutation = config => {
  const run = async input => {
    const optimistic = config.optimistic;
    let insertedId = null;
    let previous = null;
    if (optimistic && !isMethodOptimistic(optimistic)) {
      insertedId = tempId(optimistic.tempIdPrefix ?? 'temp');
      const row = optimistic.build(input, {
        tempId: insertedId
      });
      optimistic.model.insertStored({
        ...row,
        id: insertedId
      });
    } else if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.patch(id, optimistic.selectPatch(input));
    } else if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy') {
      const id = optimistic.selectId(input);
      previous = optimistic.model.get(id);
      optimistic.model.destroy(id);
    }
    try {
      const data = (await getDbRuntimeConfig().transport.mutation({
        mutation: config.document,
        variables: {
          input: config.mapInput?.(input) ?? input
        }
      })).data;
      if (optimistic && !isMethodOptimistic(optimistic)) {
        const node = optimistic.selectServerNode(data);
        if (node != null && insertedId) optimistic.model.replaceRaw(insertedId, node);
      }
      return data;
    } catch (error) {
      if (optimistic && !isMethodOptimistic(optimistic) && insertedId) optimistic.model.destroy(insertedId);
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'patch' && previous && typeof previous === 'object') optimistic.model.patch(optimistic.selectId(input), previous);
      if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy' && previous && typeof previous === 'object') optimistic.model.insertStored(previous);
      throw error;
    }
  };
  return {
    run,
    use: () => {
      const [isPending, setPending] = useState(false);
      const [error, setError] = useState(null);
      const mutateAsync = useCallback(async input => {
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
//# sourceMappingURL=defineMutation.js.map