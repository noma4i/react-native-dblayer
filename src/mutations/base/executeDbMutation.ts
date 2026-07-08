import type { DbMutationConfig } from '../../types';
import { getDbExtractSink, getDbMutationExtractResolver } from '../../core/extract';
import { getDbTransport } from '../../core/transport';
import { isRecord } from '../../utils/normalizeHelpers';
import { mergeSyncContract } from '../../utils/serverSync';
import { mergeOptimisticSnapshot } from './mergeOptimisticSnapshot';
import { emitMutationTrackSuccess } from './mutationTracking';

/**
 * Execute only the network request portion of a DB mutation config.
 * @param config Mutation config containing the document and result field.
 * @param mappedInput Input already transformed for `variables.input`.
 * @returns Mutation result field or null.
 */
export const executeDbMutationRequest = async <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
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

const readInputTempId = (input: unknown): string | null => {
  if (!isRecord(input)) return null;
  const tempId = input.tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};

const readOptimisticRow = (context: unknown): unknown => {
  if (typeof context !== 'object' || context === null) return null;
  return (context as { optimisticRow?: unknown }).optimisticRow ?? null;
};

const applyPreserveOnCommit = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
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

const applyOptimisticMutationCommit = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
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
export const applyDbMutationCommit = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  result: TData | null,
  input: TInput,
  context: TContext
): void => {
  if (config.extract) {
    getDbExtractSink()(getDbMutationExtractResolver()(config.extract, result), config.extractSource ?? 'mutation');
  }
  applyOptimisticMutationCommit(config, result, input, context);
  (config.onCommit as ((data: TData | null, input: TInput, context: unknown) => void) | undefined)?.(result, input, context);
  emitMutationTrackSuccess(config, result, input, context);
};

const buildDirectCommitContext = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
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

/**
 * Apply a `method: 'patch'` or `method: 'destroy'` config's local-row write before the transport call,
 * mirroring `useDbMutation`'s optimistic switch for these two methods exactly (same public
 * `model.patch`/`model.destroy` choke-points, so cascade behavior on destroy matches the hook path).
 * No-op for any other `method` - those configs rely on `config.optimistic`/`config.onMutate` instead,
 * which `runDbMutationDirect` does not run (it has no transaction/rollback machinery).
 */
const applyDirectPatchOrDestroyOptimisticMutation = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  input: TInput
): void => {
  if (config.method === 'destroy') {
    const id = config.selectId(input);
    if (id) {
      config.model.destroy(id);
    }
    return;
  }

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
 * Patch configs apply `selectPatch` and destroy configs remove the local row via `selectId` before the
 * transport call; neither rolls back when the request fails - the local write is unconditional and
 * permanent regardless of the transport outcome, same asymmetry as the `useDbMutation` hook path.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context passed to `onCommit`.
 * @returns Mutation result field or null.
 */
export const runDbMutationDirect = async <TData, TInput, TContext = void, TStored = unknown, TServerNode = unknown, TExtractSpec = unknown>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  input: TInput,
  context?: TContext
): Promise<TData | null> => {
  const mappedInput = config.mapInput ? config.mapInput(input) : input;
  applyDirectPatchOrDestroyOptimisticMutation(config, input);
  const result = await executeDbMutationRequest(config, mappedInput);
  applyDbMutationCommit(config, result, input, buildDirectCommitContext(config, input, context) as TContext);
  return result;
};
