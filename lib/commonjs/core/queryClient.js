"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbQueryClient = exports.resetDbQueryRuntime = exports.refetchDbRequests = exports.invalidateModel = exports.invalidateDbRequests = exports.getDbQueryClient = void 0;
var _deriveDbKey = require("./deriveDbKey.js");
var _logger = require("./logger.js");
let dbQueryClient = null;
const setDbQueryClient = queryClient => {
  dbQueryClient = queryClient ?? null;
};
exports.setDbQueryClient = setDbQueryClient;
const getDbQueryClient = () => dbQueryClient;
exports.getDbQueryClient = getDbQueryClient;
const withDbQueryClient = operation => {
  const queryClient = getDbQueryClient();
  if (!queryClient) {
    (0, _logger.getDbLogger)().error(`[${operation}] configureDb({ queryClient }) is required for imperative query operations.`);
    return null;
  }
  return queryClient;
};
const invalidateDbRequests = async key => {
  const queryClient = withDbQueryClient('invalidateDbRequests');
  if (!queryClient) return;
  await queryClient.invalidateQueries({
    queryKey: key
  });
};
exports.invalidateDbRequests = invalidateDbRequests;
const invalidateModel = (model, scope) => {
  void invalidateDbRequests((0, _deriveDbKey.deriveDbKey)(model, scope));
};
exports.invalidateModel = invalidateModel;
const refetchDbRequests = async (key, opts) => {
  const queryClient = withDbQueryClient('refetchDbRequests');
  if (!queryClient) return;
  await queryClient.refetchQueries({
    queryKey: key,
    exact: opts?.exact ?? false
  });
};
exports.refetchDbRequests = refetchDbRequests;
const resetDbQueryRuntime = async () => {
  const queryClient = withDbQueryClient('resetDbQueryRuntime');
  if (!queryClient) return;
  await queryClient.cancelQueries();
  queryClient.clear();
};
exports.resetDbQueryRuntime = resetDbQueryRuntime;
//# sourceMappingURL=queryClient.js.map