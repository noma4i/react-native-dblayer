import { createTransaction } from '@tanstack/db';
import { useMutation } from '@tanstack/react-query';
import type { DbMutationConfig, DbMutationOptimisticConfig, DbOptimisticMutationContext, PersistentMutationTransaction } from '../../types';
import { getDbLogger } from '../../core/logger';
import { acceptPersistentCollectionMutations, runInManagedMutationBatch } from '../../core/registry';
import { generateTempId } from '../../utils/generateTempId';
import { isRecord } from '../../utils/normalizeHelpers';
import { applyDbMutationCommit, executeDbMutationRequest } from './executeDbMutation';
import { resolveMutationKey, resolveMutationLogPrefix } from './mutationConfig';
import { emitMutationTrackError, emitMutationTrackStart } from './mutationTracking';
import { createSingleFlightSignature, runSingleFlight } from './singleFlight';

const defaultSelectTempId = <TInput>(input: TInput): string | null => {
  if (!isRecord(input)) return null;
  const tempId = input.tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};

const mergeMutationContexts = (optimisticContext: DbOptimisticMutationContext | undefined, manualContext: unknown): unknown => {
  if (!optimisticContext) return manualContext;
  if (manualContext === undefined) return optimisticContext;
  if (isRecord(manualContext)) return { ...manualContext, ...optimisticContext };
  return optimisticContext;
};

const runDeclarativeOptimisticMutation = <TData, TInput, TStored, TServerNode>(
  optimistic: DbMutationOptimisticConfig<TData, TInput, TStored, TServerNode>,
  input: TInput
): DbOptimisticMutationContext => {
  const existingTempId = optimistic.selectTempId ? optimistic.selectTempId(input) : defaultSelectTempId(input);
  if (existingTempId) {
    return { tempId: existingTempId, optimisticRow: optimistic.model.get(existingTempId) ?? null };
  }

  const tempId = generateTempId(optimistic.tempIdPrefix);
  const row = optimistic.buildStored({ input, tempId });
  if (!row) return { tempId: null, optimisticRow: null };

  optimistic.model.insertStored(row);
  return { tempId, optimisticRow: row };
};

const runOptimisticMutation = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>, input: TInput): unknown => {
  switch (config.method) {
    case 'destroy': {
      const id = config.selectId(input);
      if (id) {
        config.model.destroy(id);
      }
      return undefined;
    }
    case 'patch': {
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

const shouldRunOptimisticMutation = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>): boolean => {
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
export const useDbMutation = <TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown, TExtractSpec = unknown>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>) =>
  useMutation<TData | null, Error, TInput>({
    mutationKey: resolveMutationKey(config),
    mutationFn: (input: TInput) => {
      const mappedInput = config.mapInput ? config.mapInput(input) : input;
      const mutationKey = resolveMutationKey(config);
      const logPrefix = resolveMutationLogPrefix(config);
      const singleFlightSignature = createSingleFlightSignature('db-mutation', mutationKey, mappedInput);

      return runSingleFlight(singleFlightSignature, async () => {
        // Shared log tag to keep mutation logs grouped by feature hook.
        getDbLogger().debug(logPrefix, 'mutationFn start');
        let result: TData | null = null;
        let context: unknown;

        const tx = createTransaction({
          mutationFn: ({ transaction }) => {
            // Bridge ambient transaction to all persistent collections registered at runtime.
            acceptPersistentCollectionMutations(transaction as PersistentMutationTransaction);
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
                applyDbMutationCommit(config, result, input, context as TContext);
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
          (config.onError as ((error: Error, input: TInput, context: unknown) => void) | undefined)?.(error as Error, input, context);
          emitMutationTrackError(config, error as Error, input);
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
