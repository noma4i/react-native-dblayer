"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getStoragePrefix = exports.getDbRuntimeConfig = exports.getCommitBus = exports.getApplyRuntime = exports.configureDb = void 0;
var _storagePlane = require("../core/planes/storagePlane.js");
var _logger = require("../core/logger.js");
var _tracking = require("../core/tracking.js");
var _transport = require("../core/transport.js");
var _commitBus = require("../core/apply/commitBus.js");
var _transaction = require("../core/apply/transaction.js");
let runtimeConfig = null;
let applyRuntime = null;
const commitBus = (0, _commitBus.createCommitBus)();

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
const configureDb = options => {
  runtimeConfig = {
    ...options,
    storage: options.storage ?? (0, _storagePlane.mmkvStoragePlane)()
  };
  applyRuntime = null;
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

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 */
exports.getCommitBus = getCommitBus;
const getApplyRuntime = () => {
  if (!applyRuntime) {
    const {
      storage
    } = getDbRuntimeConfig();
    applyRuntime = (0, _transaction.createApplyRuntime)({
      storage,
      prefix: getStoragePrefix,
      bus: commitBus
    });
  }
  return applyRuntime;
};
exports.getApplyRuntime = getApplyRuntime;
//# sourceMappingURL=configure.js.map