"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelDefinitions = void 0;
var _logger = require("../core/logger.js");
var _serialize = require("../core/serialize.js");
var _transport = require("../core/transport.js");
var _modelStatusPoller = require("../utils/modelStatusPoller.js");
var _defineQuery = require("./defineQuery.js");
const createModelDefinitions = options => ({
  query: (name, queryConfig) => {
    const model = options.context.model();
    return (0, _defineQuery.defineQuery)({
      ...queryConfig,
      key: queryConfig.key ?? (0, _serialize.compositeKey)(options.modelId, name),
      into: queryConfig.into ?? model
    });
  },
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
  })
});
exports.createModelDefinitions = createModelDefinitions;
//# sourceMappingURL=modelDefinitions.js.map