import { createTransaction } from '@tanstack/db';
import { useMutation } from '@tanstack/react-query';
import type { DbMutationConfig, PersistentMutationTransaction } from '../../types';
import { getDbLogger } from '../../core/logger';
import { acceptPersistentCollectionMutations, runInManagedMutationBatch } from '../../core/registry';
import { applyDbMutationCommit, executeDbMutationRequest } from './executeDbMutation';
import { createSingleFlightSignature, runSingleFlight } from './singleFlight';

const runOptimisticMutation = <TData, TInput, TContext, TStored>(config: DbMutationConfig<TData, TInput, TContext, TStored>, input: TInput): TContext | undefined => {
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
      return config.onMutate?.(input);
  }
};

const shouldRunOptimisticMutation = <TData, TInput, TContext, TStored>(config: DbMutationConfig<TData, TInput, TContext, TStored>): boolean => {
  if (config.method === 'destroy' || config.method === 'patch') return true;
  return Boolean(config.onMutate);
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
export const useDbMutation = <TData, TInput, TContext = void, TStored = unknown>(config: DbMutationConfig<TData, TInput, TContext, TStored>) =>
  useMutation<TData | null, Error, TInput>({
    mutationKey: config.key(),
    mutationFn: (input: TInput) => {
      const mappedInput = config.mapInput ? config.mapInput(input) : input;
      const singleFlightSignature = createSingleFlightSignature('db-mutation', config.key(), mappedInput);

      return runSingleFlight(singleFlightSignature, async () => {
        // Shared log tag to keep mutation logs grouped by feature hook.
        getDbLogger().debug(config.logPrefix, 'mutationFn start');
        let result: TData | null = null;
        let context: TContext = undefined as TContext;

        const tx = createTransaction({
          mutationFn: ({ transaction }) => {
            // Bridge ambient transaction to all persistent collections registered at runtime.
            acceptPersistentCollectionMutations(transaction as PersistentMutationTransaction);
            return Promise.resolve();
          },
          autoCommit: false
        });

        try {
          if (shouldRunOptimisticMutation(config)) {
            tx.mutate(() => {
              const nextContext = runInManagedMutationBatch(() => runOptimisticMutation(config, input));
              if (nextContext !== undefined) {
                context = nextContext;
              }
            });
          }

          result = await executeDbMutationRequest(config, mappedInput);

          // Server write-through (extract presets + onCommit) runs in the same
          // transaction, after the network response, before tx.commit().
          if (config.extract || config.onCommit) {
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
          config.onError?.(error as Error, input, context);
          throw error;
        }

        config.invalidate?.(result, input);

        return result;
      });
    },
    onError: error => {
      getDbLogger().error(config.logPrefix, 'onError', error);
    }
  });
