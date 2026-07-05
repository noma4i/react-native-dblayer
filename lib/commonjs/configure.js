"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.configureDb = void 0;
var _extract = require("./core/extract.js");
var _logger = require("./core/logger.js");
var _modelDefaults = require("./core/modelDefaults.js");
var _storage = require("./core/storage.js");
var _transport = require("./core/transport.js");
/**
 * Configure package-wide transport, storage, logger, and extract seams.
 * @param options Runtime seams for the DB layer.
 * @returns void
 *
 * @example
 * configureDb({ transport, storage, logger });
 */
const configureDb = options => {
  (0, _transport.setDbTransport)(options.transport);
  if (options.storage) (0, _storage.setDbStorageAdapter)(options.storage);
  if (options.logger) (0, _logger.setDbLogger)(options.logger);
  if (options.extract?.sink) (0, _extract.setDbExtractSink)(options.extract.sink);
  if (options.extract?.mutationResolver) (0, _extract.setDbMutationExtractResolver)(options.extract.mutationResolver);
  (0, _modelDefaults.setDbModelDefaults)(options.modelDefaults);
};
exports.configureDb = configureDb;
//# sourceMappingURL=configure.js.map