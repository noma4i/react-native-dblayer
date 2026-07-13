"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbQueryClient = exports.resetDbQueryRuntime = exports.refetchDbRequests = exports.invalidateModel = exports.invalidateDbRequests = exports.getDbQueryClient = void 0;
var _configuredSlot = require("./configuredSlot.js");
var _deriveDbKey = require("./deriveDbKey.js");
var _freshnessStorage = require("./freshnessStorage.js");
var _logger = require("./logger.js");
const dbQueryClient = (0, _configuredSlot.createConfiguredSlot)(null);
const setDbQueryClient = queryClient => {
  dbQueryClient.set(queryClient ?? null);
};

/**
 * Read the configured QueryClient used by imperative DB request helpers.
 *
 * @returns The current QueryClient, or `null` when not configured.
 */
exports.setDbQueryClient = setDbQueryClient;
const getDbQueryClient = () => dbQueryClient.get();
exports.getDbQueryClient = getDbQueryClient;
const withDbQueryClient = operation => {
  const queryClient = getDbQueryClient();
  if (!queryClient) {
    (0, _logger.getDbLogger)().error(`[${operation}] configureDb({ queryClient }) is required for imperative query operations.`);
    return null;
  }
  return queryClient;
};

/**
 * Invalidate React Query entries for a DB request key.
 *
 * @param key Query key to invalidate.
 * @returns A promise that resolves after invalidation finishes or immediately when no QueryClient is configured.
 */
const invalidateDbRequests = async key => {
  const queryClient = withDbQueryClient('invalidateDbRequests');
  if (!queryClient) return;
  await queryClient.invalidateQueries({
    queryKey: key
  });
};

/**
 * Clear model freshness metadata and invalidate the derived request key.
 *
 * @param model Collection model whose derived key and freshness metadata should be invalidated.
 * @param scope Optional stored-row filter scope; omit to invalidate every scope for the model.
 */
exports.invalidateDbRequests = invalidateDbRequests;
const invalidateModel = (model, scope) => {
  if (scope) {
    model.clearFetchState(scope);
  } else {
    (0, _logger.getDbLogger)().debug('db', 'freshness:clear', {
      model: model.collection.id,
      scope: undefined
    });
    (0, _freshnessStorage.clearCollectionFetchStates)(model.collection.id);
  }
  void invalidateDbRequests((0, _deriveDbKey.deriveDbKey)(model, scope));
};

/**
 * Refetch React Query entries for a DB request key.
 *
 * @param key Query key to refetch.
 * @param opts Optional exact-match setting passed to React Query.
 * @returns A promise that resolves after refetch finishes or immediately when no QueryClient is configured.
 */
exports.invalidateModel = invalidateModel;
const refetchDbRequests = async (key, opts) => {
  const queryClient = withDbQueryClient('refetchDbRequests');
  if (!queryClient) return;
  await queryClient.refetchQueries({
    queryKey: key,
    exact: opts?.exact ?? false
  });
};

/**
 * Cancel and clear every query in the configured QueryClient.
 *
 * @returns A promise that resolves after reset finishes or immediately when no QueryClient is configured.
 */
exports.refetchDbRequests = refetchDbRequests;
const resetDbQueryRuntime = async () => {
  const queryClient = withDbQueryClient('resetDbQueryRuntime');
  if (!queryClient) return;
  await queryClient.cancelQueries();
  queryClient.clear();
};
exports.resetDbQueryRuntime = resetDbQueryRuntime;
//# sourceMappingURL=queryClient.js.map