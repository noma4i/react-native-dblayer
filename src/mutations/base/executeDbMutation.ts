import type { DbMutationConfig } from '../../types';
import { getDbExtractSink, getDbMutationExtractResolver } from '../../core/extract';
import { getDbTransport } from '../../core/transport';
import { mergeSyncContract } from '../../utils/serverSync';
import { mergeOptimisticSnapshot } from './mergeOptimisticSnapshot';
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readInputTempId = (input: unknown): string | null => {
  if (!isRecord(input)) return null;
  const tempId = input.tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};

const readOptimisticRow = (context: unknown): unknown => {
  if (typeof context !== 'object' || context === null) return null;
  return (context as { optimisticRow?: unknown }).optimisticRow ?? null;
};

const applyPreserveOnCommit = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  node: TServerNode,
  context: TContext
): TServerNode => {
  const preserve = config.optimistic?.preserveOnCommit;
  if (!preserve) return node;

  if (typeof preserve === 'function') {
    return preserve(node, context as { tempId: string | null; optimisticRow: TStored | null });
  }

  return mergeOptimisticSnapshot(readOptimisticRow(context) as object | null, node as object, preserve as never) as TServerNode;
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
  const preservedNode = applyPreserveOnCommit(config, node, context);

  const tempId = readOptimisticTempId(context);
  if (tempId) {
    config.optimistic.model.replaceRaw(tempId, preservedNode);
  } else {
    config.optimistic.model.applyServerData([preservedNode], mergeSyncContract('mutation'));
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

const buildDirectCommitContext = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  input: TInput,
  context: TContext | undefined
): TContext | ({ tempId: string | null; optimisticRow: TStored | null } & Record<string, unknown>) | undefined => {
  if (!config.optimistic) return context;

  const tempId = readOptimisticTempId(context) ?? (config.optimistic.selectTempId ? (config.optimistic.selectTempId(input) ?? null) : readInputTempId(input));
  const optimisticContext = {
    tempId,
    optimisticRow: tempId ? (config.optimistic.model.get(tempId) ?? null) : null
  };

  if (isRecord(context)) {
    return { ...context, ...optimisticContext };
  }

  return optimisticContext;
};

const applyDirectPatchOptimisticMutation = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  input: TInput
): void => {
  if (config.method !== 'patch') return;
  const id = config.selectId(input);
  if (!id) return;
  const patch = config.selectPatch(input, config.model.get(id));
  if (patch) {
    config.model.patch(id, patch);
  }
};

/**
 * Run a DB mutation config outside React without optimistic transaction handling.
 * Patch configs apply `selectPatch` before the transport call and do not roll back when the request fails.
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
  applyDirectPatchOptimisticMutation(config, input);
  const result = await executeDbMutationRequest(config, mappedInput);
  applyDbMutationCommit(config, result, input, buildDirectCommitContext(config, input, context) as TContext);
  return result;
};
