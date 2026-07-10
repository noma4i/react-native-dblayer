"use strict";

import { getDbExtractSink, getDbMutationExtractResolver } from "../../core/extract.js";
import { getDbTransport } from "../../core/transport.js";
import { isRecord } from "../../utils/normalizeHelpers.js";
import { mergeSyncContract } from "../../utils/serverSync.js";
import { mergeOptimisticSnapshot } from "./mergeOptimisticSnapshot.js";
import { emitMutationTrackError, emitMutationTrackStart, emitMutationTrackSuccess } from "./mutationTracking.js";

/**
 * Execute only the network request portion of a DB mutation config.
 * @param config Mutation config containing the document and result field.
 * @param mappedInput Input already transformed for `variables.input`.
 * @returns Mutation result field or null.
 */
export const executeDbMutationRequest = async (config, mappedInput) => {
  const response = await getDbTransport().mutation({
    mutation: config.mutation,
    variables: {
      input: mappedInput
    }
  });
  return response.data[config.resultField] ?? null;
};
const readOptimisticTempId = context => {
  if (typeof context !== 'object' || context === null) return null;
  const tempId = context.tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};
export const readMutationTempId = input => {
  if (!isRecord(input)) return null;
  const tempId = input.tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};
const readOptimisticRow = context => {
  if (typeof context !== 'object' || context === null) return null;
  return context.optimisticRow ?? null;
};
const applyPreserveOnCommit = (config, node, context) => {
  const preserve = config.optimistic?.preserveOnCommit;
  if (!preserve) return node;
  if (typeof preserve === 'function') {
    return preserve(node, context);
  }
  return mergeOptimisticSnapshot(readOptimisticRow(context), node, preserve);
};
const applyOptimisticMutationCommit = (config, result, input, context) => {
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
export const applyDbMutationCommit = (config, result, input, context) => {
  if (config.extract) {
    getDbExtractSink()(getDbMutationExtractResolver()(config.extract, result), config.extractSource ?? 'mutation');
  }
  applyOptimisticMutationCommit(config, result, input, context);
  config.onCommit?.(result, input, context);
  emitMutationTrackSuccess(config, result, input, context);
};
const buildDirectCommitContext = (config, input, context) => {
  if (!config.optimistic) return context;
  const tempId = readOptimisticTempId(context) ?? (config.optimistic.selectTempId ? config.optimistic.selectTempId(input) ?? null : readMutationTempId(input));
  const optimisticContext = {
    tempId,
    optimisticRow: tempId ? config.optimistic.model.get(tempId) ?? null : null
  };
  if (isRecord(context)) {
    return {
      ...context,
      ...optimisticContext
    };
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
const applyDirectPatchOrDestroyOptimisticMutation = (config, input) => {
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
export const executeDbMutationLifecycle = async (config, input, mappedInput, options) => {
  let context = options.context;
  let result = null;
  try {
    emitMutationTrackStart(config, input);
    if (options.beforeRequest) {
      context = options.beforeRequest();
    }
    result = await executeDbMutationRequest(config, mappedInput);
    await options.commit(result, context);
  } catch (error) {
    const mutationError = error;
    options.rollback?.(mutationError, context);
    config.onError?.(mutationError, input, context);
    emitMutationTrackError(config, mutationError, input);
    throw error;
  }
  config.invalidate?.(result, input);
  return result;
};

/**
 * Run a DB mutation config outside React without optimistic transaction handling.
 * Patch configs apply `selectPatch` and destroy configs remove the local row via `selectId` before the
 * transport call; neither rolls back when the request fails - the local write is unconditional and
 * permanent regardless of the transport outcome, same asymmetry as the `useDbMutation` hook path.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context merged into optimistic row metadata for `onCommit` and `onError`.
 * @returns Mutation result field or null.
 */
export const runDbMutationDirect = async (config, input, context) => {
  const mappedInput = config.mapInput ? config.mapInput(input) : input;
  const directContext = buildDirectCommitContext(config, input, context);
  return executeDbMutationLifecycle(config, input, mappedInput, {
    context: directContext,
    beforeRequest: () => {
      applyDirectPatchOrDestroyOptimisticMutation(config, input);
      return directContext;
    },
    commit: (result, commitContext) => {
      applyDbMutationCommit(config, result, input, commitContext);
    }
  });
};
//# sourceMappingURL=executeDbMutation.js.map