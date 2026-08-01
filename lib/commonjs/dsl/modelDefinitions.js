"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelDefinitions = void 0;
var _compileDbWhere = require("../core/compileDbWhere.js");
var _logger = require("../core/logger.js");
var _serialize = require("../core/serialize.js");
var _subscriptionRuntime = require("../core/subscriptionRuntime.js");
var _transport = require("../core/transport.js");
var _modelStatusPoller = require("../utils/modelStatusPoller.js");
var _react = require("react");
var _defineDetachedOperation = require("./defineDetachedOperation.js");
var _defineFetch = require("./defineFetch.js");
var _defineIngest = require("./defineIngest.js");
var _defineMutation = require("./defineMutation.js");
var _defineQuery = require("./defineQuery.js");
const createModelDefinitions = options => ({
  // The runtime branch adds `live` exactly when the overload's live config is present.
  query: (name, queryConfig) => {
    const model = options.context.model();
    const {
      live,
      ...queryOptions
    } = queryConfig;
    const handle = (0, _defineQuery.defineQuery)({
      ...queryOptions,
      key: queryConfig.key ?? (0, _serialize.compositeKey)(options.modelId, name),
      into: queryConfig.into ?? model
    });
    if (!live) return handle;
    const compiled = (0, _defineIngest.defineModelIngest)(model, live);
    let runtime = null;
    let readers = 0;
    const sync = () => {
      if (readers === 0) return;
      runtime ??= (0, _subscriptionRuntime.createDbSubscriptionRuntime)(compiled.entries);
      runtime.setActive(true);
    };
    model.registerReset(() => {
      // stop(), not setActive(false): the replaced runtime is discarded forever, so its own reset
      // registration must be released too - otherwise every reset leaks one dead registry entry.
      runtime?.stop();
      runtime = null;
      sync();
    });
    return {
      ...handle,
      use: (scope, readOptions) => {
        const result = handle.use(scope, readOptions);
        (0, _react.useEffect)(() => {
          readers += 1;
          sync();
          return () => {
            readers -= 1;
            if (readers === 0) runtime?.setActive(false);
          };
        }, []);
        return result;
      },
      live: {
        apply: compiled.apply
      }
    };
  },
  mutation: (name, mutationConfig) => {
    /** Mutation dedupe keys are idempotency identities, not scope bucket keys; scope validation belongs to scope handles and queries. */
    const dedupe = mutationConfig.dedupe === false ? false : mutationConfig.dedupe ?? {
      key: input => (0, _serialize.compositeKey)(options.modelId, name, (0, _compileDbWhere.buildScopeKey)(input))
    };
    return (0, _defineMutation.defineModelMutation)((0, _serialize.compositeKey)(options.modelId, name), {
      ...mutationConfig,
      dedupe
    });
  },
  detached: (kind, detachedConfig) => (0, _defineDetachedOperation.defineDetachedOperation)(options.context.model(), kind, detachedConfig),
  fetch: (name, fetchConfig) => (0, _defineFetch.defineFetch)({
    ...fetchConfig,
    key: fetchConfig.key ?? (0, _serialize.compositeKey)(options.modelId, name)
  }),
  poller: (name, pollerConfig) => (0, _modelStatusPoller.createModelStatusPoller)({
    ...pollerConfig,
    fetch: async id => {
      try {
        return (await (0, _transport.getDbTransport)().query({
          query: pollerConfig.document,
          variables: pollerConfig.vars?.(id) ?? {
            id
          }
        })).data;
      } catch (error) {
        (0, _logger.getDbLogger)().error('Model.poller', 'fetch failed', {
          key: (0, _serialize.compositeKey)(options.modelId, name),
          id,
          error
        });
        throw error;
      }
    }
  }),
  ingest: entries => (0, _defineIngest.defineModelIngest)(options.context.model(), entries)
});
exports.createModelDefinitions = createModelDefinitions;
//# sourceMappingURL=modelDefinitions.js.map