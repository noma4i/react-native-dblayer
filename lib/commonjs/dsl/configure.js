"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setAccountPartition = exports.getDbRuntimeConfig = exports.getCommitBus = exports.getAccountPartitionPrefix = exports.configureDb = void 0;
var _storagePlane = require("../core/planes/storagePlane.js");
var _logger = require("../core/logger.js");
var _tracking = require("../core/tracking.js");
var _transport = require("../core/transport.js");
var _commitBus = require("../core/apply/commitBus.js");
let runtimeConfig = null;
let accountId = 'anon';
const commitBus = (0, _commitBus.createCommitBus)();

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
const setAccountPartition = nextAccountId => {
  accountId = nextAccountId ?? 'anon';
};
exports.setAccountPartition = setAccountPartition;
const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};
exports.getDbRuntimeConfig = getDbRuntimeConfig;
const getAccountPartitionPrefix = () => `dbl:${accountId}:`;
exports.getAccountPartitionPrefix = getAccountPartitionPrefix;
const getCommitBus = () => commitBus;
exports.getCommitBus = getCommitBus;
//# sourceMappingURL=configure.js.map