"use strict";

import { deriveDbKey } from "./deriveDbKey.js";
import { clearCollectionFetchStates } from "./freshnessStorage.js";
import { getDbLogger } from "./logger.js";
let dbQueryClient = null;
export const setDbQueryClient = queryClient => {
  dbQueryClient = queryClient ?? null;
};
export const getDbQueryClient = () => dbQueryClient;
const withDbQueryClient = operation => {
  const queryClient = getDbQueryClient();
  if (!queryClient) {
    getDbLogger().error(`[${operation}] configureDb({ queryClient }) is required for imperative query operations.`);
    return null;
  }
  return queryClient;
};
export const invalidateDbRequests = async key => {
  const queryClient = withDbQueryClient('invalidateDbRequests');
  if (!queryClient) return;
  await queryClient.invalidateQueries({
    queryKey: key
  });
};
export const invalidateModel = (model, scope) => {
  if (scope) {
    model.clearFetchState(scope);
  } else {
    getDbLogger().debug('db', 'freshness:clear', {
      model: model.collection.id,
      scope: undefined
    });
    clearCollectionFetchStates(model.collection.id);
  }
  void invalidateDbRequests(deriveDbKey(model, scope));
};
export const refetchDbRequests = async (key, opts) => {
  const queryClient = withDbQueryClient('refetchDbRequests');
  if (!queryClient) return;
  await queryClient.refetchQueries({
    queryKey: key,
    exact: opts?.exact ?? false
  });
};
export const resetDbQueryRuntime = async () => {
  const queryClient = withDbQueryClient('resetDbQueryRuntime');
  if (!queryClient) return;
  await queryClient.cancelQueries();
  queryClient.clear();
};
//# sourceMappingURL=queryClient.js.map