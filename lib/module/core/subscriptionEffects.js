"use strict";

import { createGenerationRegistry } from "./generationRegistry.js";

/**
 * Definition registry: effect channels are created once at app-module load and outlive
 * `resetRuntime`, so the registry survives the kill-switch. Same-generation duplicate names still
 * throw; a later-generation registration replaces the previous one.
 */
const effectsRegistry = createGenerationRegistry();

/** Resolve an injected subscription effect by its stable application name. */
export const getSubscriptionEffect = name => effectsRegistry.get(name);

/** Create an injectable effects channel for subscription entries. */
export const createSubscriptionEffects = noopEffects => {
  let activeEffects = noopEffects;
  const names = Object.keys(noopEffects);
  for (const name of names) {
    effectsRegistry.assertCanRegister(name, `subscription effect already registered: ${name}`);
  }
  const effects = {};
  for (const name of names) {
    const key = name;
    const effect = (...args) => {
      activeEffects[key](...args);
    };
    effects[key] = effect;
  }
  const unregisterEffects = Object.entries(effects).map(([name, effect]) => effectsRegistry.register(name, effect, `subscription effect already registered: ${name}`));
  const unregisterNames = () => {
    for (const unregister of unregisterEffects) unregister();
  };
  return {
    effects,
    configure: overrides => {
      activeEffects = {
        ...noopEffects,
        ...overrides
      };
    },
    reset: () => {
      activeEffects = noopEffects;
      unregisterNames();
    }
  };
};
//# sourceMappingURL=subscriptionEffects.js.map