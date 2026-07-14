"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getStoragePrefix = exports.getDbRuntimeConfig = exports.getCommitBus = exports.configureDb = void 0;
var _storagePlane = require("../core/planes/storagePlane.js");
var _logger = require("../core/logger.js");
var _tracking = require("../core/tracking.js");
var _transport = require("../core/transport.js");
var _commitBus = require("../core/apply/commitBus.js");
let runtimeConfig = null;
const commitBus = (0, _commitBus.createCommitBus)();

/** Single static namespace for every persisted key; the library has no account split. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
const configureDb = options => {
  runtimeConfig = {
    ...options,
    storage: options.storage ?? (0, _storagePlane.mmkvStoragePlane)()
  };
  (0, _transport.setDbTransport)(options.transport);
  if (options.logger) (0, _logger.setDbLogger)(options.logger);
  if (options.track) (0, _tracking.setDbTrackSink)(options.track);
};
exports.configureDb = configureDb;
const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};
exports.getDbRuntimeConfig = getDbRuntimeConfig;
const getStoragePrefix = () => STORAGE_PREFIX;
exports.getStoragePrefix = getStoragePrefix;
const getCommitBus = () => commitBus;
exports.getCommitBus = getCommitBus;
//# sourceMappingURL=configure.js.map