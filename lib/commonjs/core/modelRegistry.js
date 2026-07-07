"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerModel = exports.getRegisteredModel = exports.clearModelRegistry = void 0;
var _logger = require("./logger.js");
const registeredModels = new Map();

/** Register or replace a model by name. */
const registerModel = (name, model) => {
  if (registeredModels.has(name)) {
    (0, _logger.getDbLogger)().debug(`[${name}] model registry entry replaced.`);
  }
  registeredModels.set(name, model);
};

/** Read a registered model by name. */
exports.registerModel = registerModel;
const getRegisteredModel = name => {
  if (registeredModels.has(name)) return registeredModels.get(name);
  const names = Array.from(registeredModels.keys()).sort();
  const suffix = names.length > 0 ? ` Registered models: ${names.join(', ')}.` : ' No models registered.';
  throw new Error(`[${name}] model is not registered.${suffix}`);
};

/** Clear the registry between tests. */
exports.getRegisteredModel = getRegisteredModel;
const clearModelRegistry = () => {
  registeredModels.clear();
};
exports.clearModelRegistry = clearModelRegistry;
//# sourceMappingURL=modelRegistry.js.map