"use strict";

import { createTransaction } from '@tanstack/db';
import { useMutation } from '@tanstack/react-query';
import { getDbLogger } from "../../core/logger.js";
import { acceptPersistentCollectionMutations, runInManagedMutationBatch } from "../../core/registry.js";
import { generateTempId } from "../../utils/generateTempId.js";
import { applyDbMutationCommit, executeDbMutationRequest } from "./executeDbMutation.js";
import { resolveMutationKey, resolveMutationLogPrefix } from "./mutationConfig.js";
import { emitMutationTrackError, emitMutationTrackStart } from "./mutationTracking.js";
import { createSingleFlightSignature, runSingleFlight } from "./singleFlight.js";
const isRecord = value => typeof value === 'object' && value !== null;
const defaultSelectTempId = input => {
  if (!isRecord(input)) return null;
  const tempId = input.tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};
const mergeMutationContexts = (optimisticContext, manualContext) => {
  if (!optimisticContext) return manualContext;
  if (manualContext === undefined) return optimisticContext;
  if (isRecord(manualContext)) return {
    ...manualContext,
    ...optimisticContext
  };
  return optimisticContext;
};
const runDeclarativeOptimisticMutation = (optimistic, input) => {
  const existingTempId = optimistic.selectTempId ? optimistic.selectTempId(input) : defaultSelectTempId(input);
  if (existingTempId) {
    return {
      tempId: existingTempId,
      optimisticRow: optimistic.model.get(existingTempId) ?? null
    };
  }
  const tempId = generateTempId(optimistic.tempIdPrefix);
  const row = optimistic.buildStored({
    input,
    tempId
  });
  if (!row) return {
    tempId: null,
    optimisticRow: null
  };
  optimistic.model.insertStored(row);
  return {
    tempId,
    optimisticRow: row
  };
};
const runOptimisticMutation = (config, input) => {
  switch (config.method) {
    case 'destroy':
      {
        const id = config.selectId(input);
        if (id) {
          config.model.destroy(id);
        }
        return undefined;
      }
    case 'patch':
      {
        const id = config.selectId(input);
        if (!id) return undefined;
        const current = config.model.get(id);
        const patch = config.selectPatch(input, current);
        if (patch) {
          config.model.patch(id, patch);
        }
        return undefined;
      }
    default:
      return mergeMutationContexts(config.optimistic ? runDeclarativeOptimisticMutation(config.optimistic, input) : undefined, config.onMutate?.(input));
  }
};
const shouldRunOptimisticMutation = config => {
  if (config.method === 'destroy' || config.method === 'patch') return true;
  return Boolean(config.onMutate || config.optimistic);
};

/**
 * React hook that runs a transactional GraphQL mutation with optimistic writes and rollback.
 * @param config Mutation document, optimistic variant, commit, extract, and invalidation options.
 * @returns React Query mutation result.
 *
 * @example
 * const sendMessage = useDbMutation({
 *   key: () => ['sendMessage'],
 *   logPrefix: 'sendMessage',
 *   mutation: SEND_MESSAGE,
 *   resultField: 'sendMessage',
 *   onMutate: input => {
 *     const tempId = generateTempId('message');
 *     MessageModel.insertStored({ id: tempId, body: input.body, pending: true });
 *     return { tempId };
 *   },
 *   onCommit: (message, _input, context) => {
 *     if (message) MessageModel.replaceRaw(context.tempId, message);
 *   }
 * });
 */
export const useDbMutation = config => useMutation({
  mutationKey: resolveMutationKey(config),
  mutationFn: input => {
    const mappedInput = config.mapInput ? config.mapInput(input) : input;
    const mutationKey = resolveMutationKey(config);
    const logPrefix = resolveMutationLogPrefix(config);
    const singleFlightSignature = createSingleFlightSignature('db-mutation', mutationKey, mappedInput);
    return runSingleFlight(singleFlightSignature, async () => {
      // Shared log tag to keep mutation logs grouped by feature hook.
      getDbLogger().debug(logPrefix, 'mutationFn start');
      let result = null;
      let context;
      const tx = createTransaction({
        mutationFn: ({
          transaction
        }) => {
          // Bridge ambient transaction to all persistent collections registered at runtime.
          acceptPersistentCollectionMutations(transaction);
          return Promise.resolve();
        },
        autoCommit: false
      });
      try {
        emitMutationTrackStart(config, input);
        if (shouldRunOptimisticMutation(config)) {
          tx.mutate(() => {
            const nextContext = runInManagedMutationBatch(() => runOptimisticMutation(config, input));
            if (nextContext !== undefined) {
              context = nextContext;
            }
          });
        }
        result = await executeDbMutationRequest(config, mappedInput);

        // Server write-through (extract presets + onCommit + tracking) runs in the same
        // transaction, after the network response, before tx.commit().
        if (config.extract || config.onCommit || config.optimistic || config.track?.success) {
          tx.mutate(() => {
            runInManagedMutationBatch(() => {
              applyDbMutationCommit(config, result, input, context);
            });
          });
        }
        await tx.commit();
      } catch (error) {
        tx.rollback();
        // rollback() rejects tx.isPersisted with the (possibly undefined) transaction error. The
        // error path never awaits it (no commit was reached), so swallow it to avoid an unhandled
        // promise rejection. The original error is still rethrown below for the caller to handle.
        void tx.isPersisted.promise.catch(() => undefined);
        config.onError?.(error, input, context);
        emitMutationTrackError(config, error, input);
        throw error;
      }
      config.invalidate?.(result, input);
      return result;
    });
  },
  onError: error => {
    getDbLogger().error(resolveMutationLogPrefix(config), 'onError', error);
  }
});
//# sourceMappingURL=useDbMutation.js.map