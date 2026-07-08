"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runDbMutationDirect = exports.executeDbMutationRequest = exports.applyDbMutationCommit = void 0;
var _extract = require("../../core/extract.js");
var _transport = require("../../core/transport.js");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
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
const readInputTempId = input => {
  if (!(0, _normalizeHelpers.isRecord)(input)) return null;
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
    (0, _extract.getDbExtractSink)()((0, _extract.getDbMutationExtractResolver)()(config.extract, result), config.extractSource ?? 'mutation');
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
  if ((0, _normalizeHelpers.isRecord)(context)) {
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
const runDbMutationDirect = async (config, input, context) => {
  const mappedInput = config.mapInput ? config.mapInput(input) : input;
  applyDirectPatchOrDestroyOptimisticMutation(config, input);
  const result = await executeDbMutationRequest(config, mappedInput);
  applyDbMutationCommit(config, result, input, buildDirectCommitContext(config, input, context));
  return result;
};
exports.runDbMutationDirect = runDbMutationDirect;
//# sourceMappingURL=executeDbMutation.js.map