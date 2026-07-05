"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runDbMutationDirect = exports.executeDbMutationRequest = exports.applyDbMutationCommit = void 0;
var _extract = require("../../core/extract.js");
var _transport = require("../../core/transport.js");
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

/**
 * Apply extract side-loads and commit callback for a DB mutation result.
 * @param config Mutation config containing extract and commit callbacks.
 * @param result Mutation result field or null.
 * @param input Original caller input.
 * @param context Optimistic mutation context.
 * @returns void
 */
exports.executeDbMutationRequest = executeDbMutationRequest;
const applyDbMutationCommit = (config, result, input, context) => {
  if (config.extract) {
    (0, _extract.getDbExtractSink)()((0, _extract.getDbMutationExtractResolver)()(config.extract, result), 'mutation');
  }
  config.onCommit?.(result, input, context);
};

/**
 * Run a DB mutation config outside React without optimistic transaction handling.
 * @param config Same config accepted by `useDbMutation`.
 * @param input Caller input.
 * @param context Optional context passed to `onCommit`.
 * @returns Mutation result field or null.
 */
exports.applyDbMutationCommit = applyDbMutationCommit;
const runDbMutationDirect = async (config, input, context) => {
  const mappedInput = config.mapInput ? config.mapInput(input) : input;
  const result = await executeDbMutationRequest(config, mappedInput);
  applyDbMutationCommit(config, result, input, context);
  return result;
};
exports.runDbMutationDirect = runDbMutationDirect;
//# sourceMappingURL=executeDbMutation.js.map