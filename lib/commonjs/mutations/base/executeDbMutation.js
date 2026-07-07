"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runDbMutationDirect = exports.executeDbMutationRequest = exports.applyDbMutationCommit = void 0;
var _extract = require("../../core/extract.js");
var _transport = require("../../core/transport.js");
var _serverSync = require("../../utils/serverSync.js");
var _mergeOptimisticSnapshot = require("./mergeOptimisticSnapshot.js");
var _mutationTracking = require("./mutationTracking.js");
/**
 * Execute only the network request portion of a DB mutation config.
 * @param config Mutation config containing the document and result field.
 * @param mappedInput Input already transformed for `variables.input`.
 * @returns Mutation result field or null.
 */
const executeDbMutationRequest = async (config, mappedInput) => {
  const response = await (0, _transport.getDbTransport)().mutation({
    mutation: config.mutation,
    variables: {
      input: mappedInput
    }
  });
  return response.data[config.resultField] ?? null;
};
exports.executeDbMutationRequest = executeDbMutationRequest;
const readOptimisticTempId = context => {
  if (typeof context !== 'object' || context === null) return null;
  const tempId = context.tempId;
  return typeof tempId === 'string' && tempId.length > 0 ? tempId : null;
};
const isRecord = value => typeof value === 'object' && value !== null;
const readInputTempId = input => {
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
  return (0, _mergeOptimisticSnapshot.mergeOptimisticSnapshot)(readOptimisticRow(context), node, preserve);
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
    config.optimistic.model.applyServerData([preservedNode], (0, _serverSync.mergeSyncContract)('mutation'));
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
const applyDbMutationCommit = (config, result, input, context) => {
  if (config.extract) {
    (0, _extract.getDbExtractSink)()((0, _extract.getDbMutationExtractResolver)()(config.extract, result), 'mutation');
  }
  applyOptimisticMutationCommit(config, result, input, context);
  config.onCommit?.(result, input, context);
  (0, _mutationTracking.emitMutationTrackSuccess)(config, result, input, context);
};
exports.applyDbMutationCommit = applyDbMutationCommit;
const buildDirectCommitContext = (config, input, context) => {
  if (!config.optimistic) return context;
  const tempId = readOptimisticTempId(context) ?? (config.optimistic.selectTempId ? config.optimistic.selectTempId(input) ?? null : readInputTempId(input));
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
 * Run a DB mutation config outside React without optimistic transaction handling.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context passed to `onCommit`.
 * @returns Mutation result field or null.
 */
const runDbMutationDirect = async (config, input, context) => {
  const mappedInput = config.mapInput ? config.mapInput(input) : input;
  const result = await executeDbMutationRequest(config, mappedInput);
  applyDbMutationCommit(config, result, input, buildDirectCommitContext(config, input, context));
  return result;
};
exports.runDbMutationDirect = runDbMutationDirect;
//# sourceMappingURL=executeDbMutation.js.map