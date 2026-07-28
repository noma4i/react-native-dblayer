"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.validateMutationConfig = exports.isRespondOptimistic = exports.isMethodOptimistic = void 0;
var _relations = require("../core/relations.js");
var _internalHandles = require("../core/internalHandles.js");
var _bootValidations = require("./bootValidations.js");
const isMethodOptimistic = value => 'method' in value;
exports.isMethodOptimistic = isMethodOptimistic;
const isRespondOptimistic = value => 'respond' in value;
exports.isRespondOptimistic = isRespondOptimistic;
const validateMutationConfig = config => {
  if (config.once && config.dedupe === false) throw new Error('once cannot be combined with dedupe: false');
  const optimistic = config.optimistic;
  if (optimistic && isRespondOptimistic(optimistic) && (`build` in optimistic || `method` in optimistic)) {
    throw new Error('optimistic respond cannot be combined with build or method');
  }
  if (optimistic && isMethodOptimistic(optimistic) && (`prependTo` in optimistic || `appendTo` in optimistic)) {
    throw new Error('optimistic prependTo/appendTo requires an insert optimistic config');
  }
  if (optimistic && !isMethodOptimistic(optimistic) && !isRespondOptimistic(optimistic) && (0, _internalHandles.getInternalModelHandle)(optimistic.model).dropTempRowsAfterMs() === undefined) {
    throw new Error(`${optimistic.model.modelId} must declare maintenance.dropTempRowsAfterMs to be used in an optimistic insert mutation`);
  }
  if (optimistic && isMethodOptimistic(optimistic) && optimistic.method === 'destroy') {
    (0, _bootValidations.registerBootValidation)(() => {
      if ((0, _relations.hasDependentCascade)(optimistic.model.modelId)) {
        throw new Error(`${optimistic.model.modelId}: optimistic destroy is not supported on models with dependent cascades - rollback cannot restore cascaded children`);
      }
    });
  }
  if (optimistic && !isMethodOptimistic(optimistic)) {
    if (optimistic.prependTo && optimistic.appendTo) throw new Error('optimistic prependTo and appendTo are mutually exclusive');
    const placement = optimistic.prependTo ?? optimistic.appendTo;
    if (placement && !(0, _internalHandles.getInternalScopeHandle)(placement.scope).isServerOrder()) throw new Error('optimistic prependTo/appendTo requires a server-order scope');
    if (placement && placement.scope.modelId !== optimistic.model.modelId) throw new Error('optimistic prependTo/appendTo scope must belong to the optimistic model');
  }
};
exports.validateMutationConfig = validateMutationConfig;
//# sourceMappingURL=mutationConfiguration.js.map