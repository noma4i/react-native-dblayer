"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useCollectionFetchStateVersion = exports.logFreshnessSkip = void 0;
var _react = require("react");
var _freshnessStorage = require("../../core/freshnessStorage.js");
var _logger = require("../../core/logger.js");
/** Freshness decision consumed by base query hooks before the initial fetch. */

/** Log one freshness skip decision for a model scope. */
const logFreshnessSkip = (model, scopeKey, fetchState) => {
  if (!fetchState) return;
  (0, _logger.getDbLogger)().debug('db', 'freshness:skip', {
    model,
    scopeKey,
    ageMs: Date.now() - fetchState.touchedAt,
    empty: fetchState.empty
  });
};

/** Subscribe to a collection's fetch-state version, or a constant 0 when no collection is bound. */
exports.logFreshnessSkip = logFreshnessSkip;
const useCollectionFetchStateVersion = collectionId => {
  const subscribe = (0, _react.useCallback)(listener => collectionId ? (0, _freshnessStorage.subscribeCollectionFetchState)(collectionId, listener) : () => {}, [collectionId]);
  const getSnapshot = (0, _react.useCallback)(() => collectionId ? (0, _freshnessStorage.getCollectionFetchStateVersion)(collectionId) : 0, [collectionId]);
  return (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
};
exports.useCollectionFetchStateVersion = useCollectionFetchStateVersion;
//# sourceMappingURL=freshnessGate.js.map