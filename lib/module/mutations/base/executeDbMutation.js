"use strict";

import { getDbExtractSink, getDbMutationExtractResolver } from "../../core/extract.js";
import { getDbTransport } from "../../core/transport.js";
import { mergeSyncContract } from "../../utils/serverSync.js";
import { emitMutationTrackSuccess } from "./mutationTracking.js";

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
const applyOptimisticMutationCommit = (config, result, input, context) => {
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
export const applyDbMutationCommit = (config, result, input, context) => {
  if (config.extract) {
    getDbExtractSink()(getDbMutationExtractResolver()(config.extract, result), 'mutation');
  }
  applyOptimisticMutationCommit(config, result, input, context);
  config.onCommit?.(result, input, context);
  emitMutationTrackSuccess(config, result, input, context);
};

/**
 * Run a DB mutation config outside React without optimistic transaction handling.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context passed to `onCommit`.
 * @returns Mutation result field or null.
 */
export const runDbMutationDirect = async (config, input, context) => {
  const mappedInput = config.mapInput ? config.mapInput(input) : input;
  const result = await executeDbMutationRequest(config, mappedInput);
  applyDbMutationCommit(config, result, input, context);
  return result;
};
//# sourceMappingURL=executeDbMutation.js.map