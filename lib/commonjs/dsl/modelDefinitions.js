"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelDefinitions = void 0;
var _serialize = require("../core/serialize.js");
var _defineQuery = require("./defineQuery.js");
const createModelDefinitions = options => ({
  query: (name, queryConfig) => {
    const model = options.context.model();
    return (0, _defineQuery.defineQuery)({
      ...queryConfig,
      key: queryConfig.key ?? (0, _serialize.compositeKey)(options.modelId, name),
      into: queryConfig.into ?? model
    });
  }
});
exports.createModelDefinitions = createModelDefinitions;
//# sourceMappingURL=modelDefinitions.js.map