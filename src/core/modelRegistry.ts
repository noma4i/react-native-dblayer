import { getDbLogger } from './logger';

const registeredModels = new Map<string, unknown>();

/** Register or replace a model by name. */
export const registerModel = (name: string, model: unknown): void => {
  if (registeredModels.has(name)) {
    getDbLogger().debug(`[${name}] model registry entry replaced.`);
  }
  registeredModels.set(name, model);
};

/** Read a registered model by name. */
export const getRegisteredModel = (name: string): unknown => {
  if (registeredModels.has(name)) return registeredModels.get(name);

  const names = Array.from(registeredModels.keys()).sort();
  const suffix = names.length > 0 ? ` Registered models: ${names.join(', ')}.` : ' No models registered.';
  throw new Error(`[${name}] model is not registered.${suffix}`);
};

/** Clear the registry between tests. */
export const clearModelRegistry = (): void => {
  registeredModels.clear();
};
