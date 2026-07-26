"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.coldResetModel = exports.CorruptionError = void 0;
var _diagnostics = require("./diagnostics.js");
var _logger = require("./logger.js");
class CorruptionError extends Error {
  constructor(keyClass, storageKey) {
    super(`corrupt persisted ${keyClass} key: ${storageKey}`);
    this.keyClass = keyClass;
    this.storageKey = storageKey;
  }
}

/** Cold-model degradation: wipes every persisted snapshot key of the model (rows, tombstones, scopes, applied marker). WAL records are intentionally kept - replay re-applies un-checkpointed mutations over the clean slate. */
exports.CorruptionError = CorruptionError;
const coldResetModel = (storage, prefix, modelId) => {
  const keys = [...storage.keys(`${prefix}row:${modelId}:`), ...storage.keys(`${prefix}scope:${modelId}:`), `${prefix}tombstones:${modelId}`, `${prefix}applied:${modelId}`];
  storage.set([...new Set(keys)].map(key => ({
    key,
    value: null
  })));
  (0, _diagnostics.noteCorruptionModelReset)();
  (0, _logger.getDbLogger)().error('cold-model recovery', {
    modelId
  });
};
exports.coldResetModel = coldResetModel;
//# sourceMappingURL=recovery.js.map