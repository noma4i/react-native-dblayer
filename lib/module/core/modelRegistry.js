"use strict";

import { getDbLogger } from "./logger.js";
const registeredModels = new Map();

/** Register or replace a model by name. */
export const registerModel = (name, model) => {
  if (registeredModels.has(name)) {
    getDbLogger().debug(`[${name}] model registry entry replaced.`);
  }
  registeredModels.set(name, model);
};

/** Read a registered model by name. */
export const getRegisteredModel = name => {
  if (registeredModels.has(name)) return registeredModels.get(name);
  const names = Array.from(registeredModels.keys()).sort();
  const suffix = names.length > 0 ? ` Registered models: ${names.join(', ')}.` : ' No models registered.';
  throw new Error(`[${name}] model is not registered.${suffix}`);
};

/** Clear the registry between tests. */
export const clearModelRegistry = () => {
  registeredModels.clear();
};
//# sourceMappingURL=modelRegistry.js.map