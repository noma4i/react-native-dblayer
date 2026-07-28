"use strict";

import { getRuntimeGeneration } from "../dsl/configure.js";
const createSubscriptionEffectsRegistry = () => ({
  effects: new Map(),
  generations: new Map()
});

/**
 * Definition registry: effect channels are created once at app-module load and outlive
 * `resetRuntime`, so the registry survives the kill-switch. Same-generation duplicate names still
 * throw; a later-generation registration replaces the previous one.
 */
const effectsRegistry = createSubscriptionEffectsRegistry();

/** Resolve an injected subscription effect by its stable application name. */
export const getSubscriptionEffect = name => effectsRegistry.effects.get(name);

/** Create an injectable effects channel for subscription entries. */
export const createSubscriptionEffects = noopEffects => {
  let activeEffects = noopEffects;
  const names = Object.keys(noopEffects);
  const generation = getRuntimeGeneration();
  for (const name of names) {
    if (effectsRegistry.effects.has(name) && effectsRegistry.generations.get(name) === generation) throw new Error(`subscription effect already registered: ${name}`);
  }
  const effects = {};
  for (const name of names) {
    const key = name;
    const effect = (...args) => {
      activeEffects[key](...args);
    };
    effects[key] = effect;
  }
  for (const [name, effect] of Object.entries(effects)) {
    effectsRegistry.effects.set(name, effect);
    effectsRegistry.generations.set(name, generation);
  }
  const unregisterNames = () => {
    for (const name of names) {
      const effect = effects[name];
      if (effectsRegistry.effects.get(name) !== effect) continue;
      effectsRegistry.effects.delete(name);
      effectsRegistry.generations.delete(name);
    }
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