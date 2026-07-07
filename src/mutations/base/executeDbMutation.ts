import type { DbMutationConfig } from '../../types';
import { getDbExtractSink, getDbMutationExtractResolver } from '../../core/extract';
import { getDbTransport } from '../../core/transport';
import { mergeSyncContract } from '../../utils/serverSync';
import { emitMutationTrackSuccess } from './mutationTracking';

/**
 * Execute only the network request portion of a DB mutation config.
 * @param config Mutation config containing the document and result field.
 * @param mappedInput Input already transformed for `variables.input`.
 * @returns Mutation result field or null.
 */
export const executeDbMutationRequest = async <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  mappedInput: unknown
): Promise<TData | null> => {
  const response = await getDbTransport().mutation<Record<string, TData>, { input: unknown }>({
    mutation: config.mutation,
    variables: { input: mappedInput }
  });
  return (response.data[config.resultField] ?? null) as TData | null;
};

const readOptimisticTempId = (context: unknown): string | null => {
  if (typeof context !== 'object' || context === null) return null;
  const tempId = (context as { tempId?: unknown }).tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};

const applyOptimisticMutationCommit = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  result: TData | null,
  input: TInput,
  context: TContext
): void => {
  if (!config.optimistic) return;

  const node = config.optimistic.selectServerNode(result, input);
  if (node == null) return;

  const tempId = readOptimisticTempId(context);
  if (tempId) {
    config.optimistic.model.replaceRaw(tempId, node);
  } else {
    config.optimistic.model.applyServerData([node], mergeSyncContract('mutation'));
  }
};

/**
 * Apply extract side-loads and commit callback for a DB mutation result.
 * @param config Mutation config containing extract and commit callbacks.
 * @param result Mutation result field or null.
 * @param input Original caller input.
 * @param context Optimistic mutation context.
 * @returns void
 */
export const applyDbMutationCommit = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  result: TData | null,
  input: TInput,
  context: TContext
): void => {
  if (config.extract) {
    getDbExtractSink()(getDbMutationExtractResolver()(config.extract, result), 'mutation');
  }
  applyOptimisticMutationCommit(config, result, input, context);
  (config.onCommit as ((data: TData | null, input: TInput, context: unknown) => void) | undefined)?.(result, input, context);
  emitMutationTrackSuccess(config, result, input, context);
};

/**
 * Run a DB mutation config outside React without optimistic transaction handling.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context passed to `onCommit`.
 * @returns Mutation result field or null.
 */
export const runDbMutationDirect = async <TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  input: TInput,
  context?: TContext
): Promise<TData | null> => {
  const mappedInput = config.mapInput ? config.mapInput(input) : input;
  const result = await executeDbMutationRequest(config, mappedInput);
  applyDbMutationCommit(config, result, input, context as TContext);
  return result;
};
